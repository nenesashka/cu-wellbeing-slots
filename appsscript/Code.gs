/** CU CareSlot: Telegram webhook, subscriber store, and two-event results. */
const GITHUB_DISPATCH_URL = 'https://api.github.com/repos/nenesashka/cu-wellbeing-slots/actions/workflows/check.yml/dispatches';
const MOSCOW_TZ = 'Europe/Moscow';
const BROADCAST_BATCH_SIZE = 12;
const PRIORITY_DELAY_MS = 60 * 60 * 1000;
const PRIORITY_PAIRING_HASH = 'c387ea139e611b670ea74a211ba8d73d4a7e990feaae411c19235549a6fe2dd1';
const EVENTS = [
  {key: 'svetlana', name: 'Светлана Шутькова', mode: 'очно · кабинет 406', url: 'https://cu-events.timepad.ru/event/3219855/'},
  {key: 'lilia', name: 'Лилия Павлова', mode: 'онлайн', url: 'https://cu-events.timepad.ru/event/3558805/'}
];
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const source = e && e.parameter && e.parameter.source;
  const key = e && e.parameter && e.parameter.key;
  try {
    if (source === 'telegram' && key && key === props.getProperty('TELEGRAM_KEY')) {
      handleTelegram(JSON.parse(e.postData.contents), props);
      return HtmlService.createHtmlOutput('ok');
    }
    if (source === 'workflow' && key && key === props.getProperty('WORKFLOW_KEY')) {
      handleWorkflow(JSON.parse(e.postData.contents), props);
      return ContentService.createTextOutput('ok');
    }
  } catch (error) {
    // Never log callback URLs, tokens, user text, or payloads.
    console.error('Webhook error: ' + String(error.name || 'Error'));
    recordError('Вебхук', String(error.name || 'Error'));
    return source === 'workflow' ? ContentService.createTextOutput('error') :
      HtmlService.createHtmlOutput('error');
  }
  return HtmlService.createHtmlOutput('forbidden');
}

function handleTelegram(update, props) {
  const callback = update && update.callback_query;
  const message = callback ? callback.message : update && update.message;
  if (!message || !message.chat || message.chat.type !== 'private') return;
  const chatId = String(message.chat.id);
  if (!/^\d+$/.test(chatId)) return;
  const sender = callback ? callback.from : message.from;
  if (sender && String(sender.id) !== chatId) return;
  const messageId = callback ? Number(message.message_id || 0) : 0;
  const rawText = String(message.text || '').trim();
  const action = callback ? String(callback.data || '') :
    rawText.split(/\s+/)[0].split('@')[0];
  const isAdminAction = action === '/stats' || /^admin_(home|checks|errors|delivery|cloud|users_\d+)$/.test(action);
  const allowed = ['/start', '/check', '/help', '/stop', '/svetlana', '/lilia',
    '/priority', '/stats', 'check', 'check_svetlana', 'check_lilia', 'all', 'svetlana', 'lilia', 'help'];
  const checkView = action === 'check_svetlana' ? 'svetlana' :
    action === 'check_lilia' ? 'lilia' : 'all';
  const isCheck = action === '/check' || action === 'check' ||
    action === 'check_svetlana' || action === 'check_lilia';
  if (callback) safeAnswerCallback(callback.id);
  if (allowed.indexOf(action) < 0 && !isAdminAction) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let state, dispatchNeeded = false, requestCheck = false, priorityActivated = false;
  let adminAuthorized = false;
  try {
    const seen = JSON.parse(props.getProperty('RECENT_UPDATES') || '[]');
    const updateId = String(update.update_id);
    if (seen.indexOf(updateId) !== -1) return;
    seen.push(updateId);
    props.setProperty('RECENT_UPDATES', JSON.stringify(seen.slice(-180)));
    trackUserLocked(props, chatId, callback ? callback.from : (message.from || message.chat), action);
    const changes = {updates: 1};
    if (isCheck) changes.manualRequests = 1;
    if (action === '/start') changes.starts = 1;
    if (action === '/stop') changes.stops = 1;
    addMetricsLocked(props, changes, Date.now());
    if (action === '/priority') {
      const code = rawText.match(/^\/priority\s+([a-f0-9]{32})$/i);
      const currentOwner = props.getProperty('PRIORITY_CHAT_ID');
      if (code && hashText(code[1].toLowerCase()) === PRIORITY_PAIRING_HASH &&
          (!currentOwner || currentOwner === chatId)) {
        props.setProperty('PRIORITY_CHAT_ID', chatId);
        props.setProperty('SUB_' + chatId, '1');
        priorityActivated = true;
      }
    }
    if (action === '/start') props.setProperty('SUB_' + chatId, '1');
    if (action === '/stop') {
      props.deleteProperty('SUB_' + chatId);
      props.deleteProperty('PEND_' + chatId);
    }
    adminAuthorized = isAdminAction && props.getProperty('PRIORITY_CHAT_ID') === chatId;
    state = readState(props);
    requestCheck = isCheck ||
      (action === '/start' && EVENTS.some(function(event) { return state[event.key].status === 'unknown'; }));
    if (requestCheck) {
      props.setProperty('PEND_' + chatId, JSON.stringify({messageId: messageId, view: checkView}));
      const now = Date.now();
      if (props.getProperty('IN_FLIGHT') !== '1' ||
          now - Number(props.getProperty('LAST_DISPATCH_MS') || 0) > 600000) {
        props.setProperty('IN_FLIGHT', '1');
        props.setProperty('LAST_DISPATCH_MS', String(now));
        dispatchNeeded = true;
      }
    } else if (callback && !isAdminAction && props.getProperty('PEND_' + chatId)) {
      const pending = readPending(props.getProperty('PEND_' + chatId), chatId);
      pending.messageId = messageId;
      pending.view = action;
      props.setProperty('PEND_' + chatId, JSON.stringify(pending));
    }
  } finally {
    lock.releaseLock();
  }

  if (isAdminAction) {
    if (!adminAuthorized) {
      if (!callback) sendTelegram(chatId, 'Команда недоступна.');
      return;
    }
    const view = adminView(action, props);
    if (callback) safeEdit(chatId, messageId, view.text, view.keyboard);
    else sendTelegram(chatId, view.text, view.keyboard);
    return;
  }

  if (callback && !isCheck) {
    const view = viewMessage(action, state);
    safeEdit(chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (action === '/priority') {
    sendTelegram(chatId, priorityActivated ?
      'Приоритетные уведомления включены. При изменении слотов я напишу тебе первым; общая рассылка начнётся не раньше чем через час.' :
      'Не удалось включить приоритет. Проверь команду и код.', menuKeyboard());
    if (priorityActivated) startPriorityDelivery(props);
    return;
  }

  if (action === '/stop') {
    sendTelegram(chatId, 'Уведомления отключены. Проверять слоты вручную можно командой /check. Чтобы снова подписаться, отправьте /start.', menuKeyboard());
  } else if (action === '/help') {
    sendTelegram(chatId, helpText(), helpKeyboard());
  } else if (action === '/start') {
    const sentId = sendTelegram(chatId, welcomeText() + '\n\n' + formatReport(state) +
      (requestCheck ? '\n\nПроверяю страницы…' : ''), menuKeyboard());
    if (requestCheck) savePendingMessageId(props, chatId, sentId);
    if (dispatchNeeded) {
      try { dispatchCheck(props); }
      catch (error) { recordError('GitHub', 'запуск проверки'); failDispatch(props); }
    }
    if (props.getProperty('PRIORITY_CHAT_ID') === chatId) startPriorityDelivery(props);
  } else if (action === '/svetlana' || action === '/lilia') {
    const view = viewMessage(action.slice(1), state);
    sendTelegram(chatId, view.text, view.keyboard);
  } else {
    const view = viewMessage(checkView, state);
    const text = view.text + '\n\nПроверяю страницы…';
    if (callback) {
      safeEdit(chatId, messageId, text, view.keyboard);
    } else {
      savePendingMessageId(props, chatId, sendTelegram(chatId, text, view.keyboard));
    }
    if (dispatchNeeded) {
      try { dispatchCheck(props); }
      catch (error) { recordError('GitHub', 'запуск проверки'); failDispatch(props); }
    }
  }
}

function readPending(value, chatId) {
  try {
    const pending = JSON.parse(value);
    return {chatId: chatId, messageId: Number(pending.messageId || 0), view: pending.view || 'all'};
  } catch (error) {
    // Legacy pending value from the previous deployment.
    return {chatId: chatId, messageId: 0, view: 'all'};
  }
}

function savePendingMessageId(props, chatId, messageId) {
  if (!messageId) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const value = props.getProperty('PEND_' + chatId);
    if (!value) return;
    const pending = readPending(value, chatId);
    pending.messageId = messageId;
    props.setProperty('PEND_' + chatId, JSON.stringify(pending));
  } finally { lock.releaseLock(); }
}

function validateResult(payload) {
  if (!payload || !payload.events || !Number.isFinite(Date.parse(payload.checked_at))) {
    throw new Error('Invalid result envelope');
  }
  const checkedAt = new Date(payload.checked_at);
  if (checkedAt.getTime() > Date.now() + 300000) throw new Error('Future result');
  const startedAt = Number.isFinite(Date.parse(payload.started_at)) ?
    new Date(payload.started_at).toISOString() : '';
  const result = {checkedAt: checkedAt.toISOString(), startedAt: startedAt,
    source: payload.source, events: {}};
  EVENTS.forEach(function(event) {
    const item = payload.events[event.key];
    if (!item || typeof item !== 'object') throw new Error('Missing event result');
    if (item.error) {
      result.events[event.key] = {error: true};
      return;
    }
    if (typeof item.registration_open !== 'boolean' || !Array.isArray(item.slots)) {
      throw new Error('Invalid event result');
    }
    const slots = item.slots.map(function(slot) {
      if (!/^\d+$/.test(String(slot.id)) || !Number.isFinite(Date.parse(slot.start))) {
        throw new Error('Invalid slot');
      }
      return {id: String(slot.id), start: new Date(slot.start).toISOString()};
    }).filter(function(slot) { return Date.parse(slot.start) > Date.now(); })
      .sort(function(a, b) { return Date.parse(a.start) - Date.parse(b.start); });
    if (!item.registration_open && slots.length) throw new Error('Closed event has slots');
    result.events[event.key] = {registrationOpen: item.registration_open, slots: slots};
  });
  return result;
}

function handleWorkflow(payload, props) {
  const result = validateResult(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let pending, broadcastChanged = false, state;
  try {
    const previousResult = props.getProperty('LAST_WORKFLOW_CHECKED_AT') || '';
    if (previousResult && Date.parse(result.checkedAt) <= Date.parse(previousResult)) return;
    const lastDispatchMs = props.getProperty('IN_FLIGHT') === '1' ?
      Number(props.getProperty('LAST_DISPATCH_MS') || 0) : 0;
    const all = props.getProperties();
    pending = Object.keys(all).filter(function(key) { return /^PEND_\d+$/.test(key); })
      .map(function(key) { return readPending(all[key], key.slice(5)); });
    EVENTS.forEach(function(event) {
      const item = result.events[event.key];
      const prefix = 'EV_' + event.key.toUpperCase() + '_';
      const previous = props.getProperty(prefix + 'STATUS') || 'unknown';
      // Preserve the last known state before a manual check updates the cache.
      if (!props.getProperty(prefix + 'BROADCAST_SIGNATURE')) {
        props.setProperty(prefix + 'BROADCAST_SIGNATURE',
          previous === 'error' ? 'error' : (props.getProperty(prefix + 'SIGNATURE') || 'initial'));
      }
      let signature;
      if (item.error) {
        signature = 'error';
        props.setProperty(prefix + 'STATUS', 'error');
      } else {
        const status = item.registrationOpen ? 'open' : 'closed';
        signature = hashSlots(item.slots) + ':' + status;
        props.setProperty(prefix + 'STATUS', status);
        props.setProperty(prefix + 'SIGNATURE', signature);
        props.setProperty(prefix + 'CHECKED_AT', result.checkedAt);
        writeSlots(props, event.key, item.slots);
      }
      if (result.source === 'schedule') {
        if (signature !== props.getProperty(prefix + 'BROADCAST_SIGNATURE')) broadcastChanged = true;
        props.setProperty(prefix + 'BROADCAST_SIGNATURE', signature);
      }
    });
    pending.forEach(function(item) { props.deleteProperty('PEND_' + item.chatId); });
    props.setProperty('IN_FLIGHT', '0');
    props.setProperty('LAST_WORKFLOW_CHECKED_AT', result.checkedAt);
    state = readState(props);
    const sourceErrors = EVENTS.filter(function(event) { return !!result.events[event.key].error; });
    const durationMs = result.startedAt ? Math.max(0, Date.parse(result.checkedAt) - Date.parse(result.startedAt)) : 0;
    const scheduleDelay = result.source === 'schedule' ? scheduledDelayMs(result.startedAt) : 0;
    const manualWait = result.source === 'workflow_dispatch' && lastDispatchMs ?
      Math.max(0, Date.now() - lastDispatchMs) : 0;
    addMetricsLocked(props, {checks: 1,
      manualChecks: result.source === 'workflow_dispatch' ? 1 : 0,
      scheduledChecks: result.source === 'schedule' ? 1 : 0,
      sourceErrors: sourceErrors.length,
      durationSumMs: durationMs, durationCount: durationMs ? 1 : 0,
      scheduleDelaySumMs: scheduleDelay, scheduleDelayCount: result.source === 'schedule' && result.startedAt ? 1 : 0,
      manualWaitSumMs: manualWait, manualWaitCount: manualWait ? 1 : 0}, Date.now());
    sourceErrors.forEach(function(event) { appendErrorLocked(props, 'Источник', event.name); });
    const checkSummary = {
      checkedAt: result.checkedAt, source: result.source, durationMs: durationMs,
      scheduleDelayMs: scheduleDelay,
      manualWaitMs: manualWait,
      svetlana: result.events.svetlana.error ? 'ошибка' : result.events.svetlana.slots.length + ' слотов',
      lilia: result.events.lilia.error ? 'ошибка' : result.events.lilia.slots.length + ' слотов'
    };
    props.setProperty('METRICS_LAST_CHECK', JSON.stringify(checkSummary));
    if (result.source === 'schedule') props.setProperty('METRICS_LAST_SCHEDULE', JSON.stringify(checkSummary));
    if (result.source === 'workflow_dispatch') props.setProperty('METRICS_LAST_MANUAL', JSON.stringify(checkSummary));
    if (result.source === 'schedule' && broadcastChanged) {
      props.setProperty('PRIORITY_PENDING', JSON.stringify({
        report: formatReport(state), checkedAt: result.checkedAt, sentAt: 0, dueAt: 0
      }));
    }
  } finally {
    lock.releaseLock();
  }
  if (result.source === 'schedule' && broadcastChanged) {
    startPriorityDelivery(props);
  }
  pending.forEach(function(item) { deliverPending(item, state); });
  maybeConfigureBotProfile(props);
}

function deliverPending(item, state) {
  if (item.view === 'help') return;
  const view = viewMessage(item.view, state);
  if (item.messageId) {
    safeEdit(item.chatId, item.messageId, view.text, view.keyboard);
  } else {
    safeSend(item.chatId, view.text, view.keyboard);
  }
}

function startPriorityDelivery(props) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let owner, queued, existingDue = 0, alreadySent = false;
  try {
    owner = props.getProperty('PRIORITY_CHAT_ID');
    const raw = props.getProperty('PRIORITY_PENDING');
    if (!owner || !props.getProperty('SUB_' + owner) || !raw) return;
    queued = JSON.parse(raw);
    if (queued.sentAt === -1) {
      if (Date.now() - Number(queued.claimedAt || 0) < 60000) return;
      queued.sentAt = 0;
    }
    if (queued.sentAt) {
      alreadySent = true;
      existingDue = queued.dueAt || 0;
    } else {
      queued.sentAt = -1; // Reserve this report so concurrent callbacks cannot send it twice.
      queued.claimedAt = Date.now();
      props.setProperty('PRIORITY_PENDING', JSON.stringify(queued));
    }
  } finally { lock.releaseLock(); }
  if (alreadySent) { if (existingDue) ensureDelayedTrigger(existingDue); return; }

  const ownerSendStartedAt = Date.now();
  try {
    sendTelegram(owner, queued.report, menuKeyboard());
  } catch (error) {
    console.error('Priority delivery error: ' + String(error.status || error.name || 'Error'));
    recordError('Приоритет', String(error.status || error.name || 'Error'));
    lock.waitLock(20000);
    try {
      const current = JSON.parse(props.getProperty('PRIORITY_PENDING') || '{}');
      if (current.checkedAt === queued.checkedAt) {
        current.sentAt = 0;
        props.setProperty('PRIORITY_PENDING', JSON.stringify(current));
      }
    } finally { lock.releaseLock(); }
    return;
  }

  const sentAt = Date.now();
  const dueAt = sentAt + PRIORITY_DELAY_MS;
  lock.waitLock(20000);
  try {
    const current = JSON.parse(props.getProperty('PRIORITY_PENDING') || '{}');
    if (current.checkedAt !== queued.checkedAt) return;
    current.sentAt = sentAt;
    current.dueAt = dueAt;
    props.setProperty('PRIORITY_PENDING', JSON.stringify(current));
    const delivery = readJson(props.getProperty('METRICS_DELIVERY'), {});
    delivery.ownerAt = new Date(sentAt).toISOString();
    delivery.ownerLatencyMs = sentAt - ownerSendStartedAt;
    props.setProperty('METRICS_DELIVERY', JSON.stringify(delivery));
    addMetricsLocked(props, {ownerAlerts: 1}, sentAt);
  } finally { lock.releaseLock(); }
  ensureDelayedTrigger(dueAt);
}

function ensureDelayedTrigger(dueAt) {
  try {
    if (ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === 'deliverDelayedBroadcast';
    })) return;
    ScriptApp.newTrigger('deliverDelayedBroadcast').timeBased()
      .after(Math.max(60000, dueAt - Date.now())).create();
  } catch (error) {
    console.error('Delayed trigger error: ' + String(error.name || 'Error'));
    recordError('Таймер', String(error.name || 'Error'));
  }
}

function deliverDelayedBroadcast(e) {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let queued, owner, subscribers, earlyDueAt = 0;
  try {
    const raw = props.getProperty('PRIORITY_PENDING');
    if (raw) {
      queued = JSON.parse(raw);
      if (!queued.dueAt) queued = null;
    }
    if (queued && Date.now() < queued.dueAt) {
      earlyDueAt = queued.dueAt;
      queued = null;
    } else if (queued) {
      owner = props.getProperty('PRIORITY_CHAT_ID');
      subscribers = Object.keys(props.getProperties()).filter(function(key) { return /^SUB_\d+$/.test(key); })
        .map(function(key) { return key.slice(4); }).filter(function(chatId) { return chatId !== owner; });
      props.deleteProperty('PRIORITY_PENDING');
    }
  } finally { lock.releaseLock(); }
  if (e && e.triggerUid) ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (String(trigger.getUniqueId()) === String(e.triggerUid)) ScriptApp.deleteTrigger(trigger);
  });
  if (earlyDueAt) { ensureDelayedTrigger(earlyDueAt); return; }
  if (queued) {
    const broadcastStartedAt = Date.now();
    let outcome;
    try { outcome = broadcastTelegram(subscribers, queued.report, menuKeyboard()); }
    catch (error) {
      recordError('Общая рассылка', String(error.name || 'Error'));
      throw error;
    }
    const deliveredAt = Date.now();
    const metricsLock = LockService.getScriptLock();
    metricsLock.waitLock(10000);
    try {
      const delivery = readJson(props.getProperty('METRICS_DELIVERY'), {});
      delivery.generalAt = new Date(deliveredAt).toISOString();
      delivery.generalRecipients = outcome.sent;
      delivery.generalDurationMs = deliveredAt - broadcastStartedAt;
      props.setProperty('METRICS_DELIVERY', JSON.stringify(delivery));
      addMetricsLocked(props, {broadcasts: 1, broadcastRecipients: outcome.sent,
        deliveryFailures: outcome.failed}, deliveredAt);
    } finally { metricsLock.releaseLock(); }
  }
}

function readState(props) {
  const state = {};
  EVENTS.forEach(function(event) {
    const prefix = 'EV_' + event.key.toUpperCase() + '_';
    state[event.key] = {
      status: props.getProperty(prefix + 'STATUS') || 'unknown',
      checkedAt: props.getProperty(prefix + 'CHECKED_AT') || '',
      slots: readSlots(props, event.key)
    };
  });
  return state;
}

function welcomeText() {
  return 'Привет! Здесь можно следить за записью к психологам ЦУ: Светлане Шутьковой (очно) и Лилии Павловой (онлайн). Я проверяю слоты дважды в день и сообщаю об изменениях. Кнопка «Обновить» запускает дополнительную проверку.';
}

function helpText() {
  return 'Как пользоваться ботом\n\nНа главном экране показаны свободные слоты обоих психологов. Нажмите «Обновить», чтобы проверить запись ещё раз. Кнопки «Страница Светланы» и «Страница Лилии» открывают Timepad для записи.\n\n/check — проверить обе записи\n/start — включить уведомления\n/stop — отключить уведомления\n\nВремя московское.';
}

function formatReport(state) {
  const sections = EVENTS.map(function(event) { return formatEvent(event, state[event.key]); });
  const checked = EVENTS.map(function(event) { return state[event.key].checkedAt; }).filter(Boolean).sort();
  const footer = checked.length ? 'Проверено ' + dateLabel(checked[checked.length - 1]) + ' по Москве.' : 'Ожидаю первую проверку.';
  return 'Свободные слоты к психологам\n\n' + sections.join('\n\n') + '\n\n' + footer;
}

function formatEvent(event, item) {
  const heading = event.name + ' · ' + event.mode;
  if (!item || item.status === 'unknown') return heading + '\nДанные пока не получены.';
  if (item.status === 'error') return heading + '\n⚠️ Не удалось обновить данные.' +
    (item.checkedAt ? ' Последняя успешная проверка: ' + dateLabel(item.checkedAt) + ' по Москве.' : '');
  if (item.status === 'closed') return heading + '\nРегистрация пока закрыта.';
  if (!item.slots.length) return heading + '\nРегистрация открыта, свободных слотов сейчас нет.';
  const groups = {}, order = [];
  item.slots.forEach(function(slot) {
    const date = new Date(slot.start);
    const key = Utilities.formatDate(date, MOSCOW_TZ, 'yyyy-MM-dd');
    if (!groups[key]) {
      const day = Number(Utilities.formatDate(date, MOSCOW_TZ, 'd'));
      const month = Number(Utilities.formatDate(date, MOSCOW_TZ, 'M'));
      const year = Number(Utilities.formatDate(date, MOSCOW_TZ, 'yyyy'));
      const currentYear = Number(Utilities.formatDate(new Date(), MOSCOW_TZ, 'yyyy'));
      groups[key] = {label: day + ' ' + MONTHS_RU[month - 1] + (year === currentYear ? '' : ' ' + year), times: []};
      order.push(key);
    }
    groups[key].times.push(Utilities.formatDate(date, MOSCOW_TZ, 'HH:mm'));
  });
  return heading + '\n' + order.map(function(key) {
    return groups[key].label + ' — ' + unique(groups[key].times).join(', ');
  }).join('\n');
}

function viewMessage(view, state) {
  if (view === 'help') return {text: helpText(), keyboard: helpKeyboard()};
  if (view === 'svetlana' || view === 'lilia') {
    const event = EVENTS[view === 'lilia' ? 1 : 0];
    const item = state[event.key];
    return {
      text: formatEvent(event, item) + '\n\n' +
        (item.checkedAt ? 'Проверено ' + dateLabel(item.checkedAt) + ' по Москве.' : 'Время московское.'),
      keyboard: eventKeyboard(event)
    };
  }
  return {text: formatReport(state), keyboard: menuKeyboard()};
}

function menuKeyboard() {
  return {inline_keyboard: [
    [{text: 'Обновить', callback_data: 'check'}],
    [{text: 'Страница Светланы', url: EVENTS[0].url}],
    [{text: 'Страница Лилии', url: EVENTS[1].url}],
    [{text: 'Как это работает', callback_data: 'help'}]
  ]};
}

function helpKeyboard() {
  return {inline_keyboard: [[{text: '← К слотам', callback_data: 'all'}]]};
}

function eventKeyboard(event) {
  return {inline_keyboard: [
    [{text: 'Страница ' + (event.key === 'lilia' ? 'Лилии' : 'Светланы'), url: event.url}],
    [{text: 'Все слоты', callback_data: 'all'}, {text: 'Обновить', callback_data: 'check_' + event.key}]
  ]};
}

function dateLabel(value) {
  return Utilities.formatDate(new Date(value), MOSCOW_TZ, 'dd.MM.yyyy HH:mm');
}

function dispatchCheck(props) {
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GitHub token unavailable');
  const response = UrlFetchApp.fetch(GITHUB_DISPATCH_URL, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ref: 'main'}),
    muteHttpExceptions: true, timeoutSeconds: 15,
    headers: {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'CareSlot'}
  });
  if (response.getResponseCode() !== 204) throw new Error('GitHub dispatch failed');
}

function failDispatch(props) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let pending, state;
  try {
    const all = props.getProperties();
    pending = Object.keys(all).filter(function(key) { return /^PEND_\d+$/.test(key); })
      .map(function(key) { props.deleteProperty(key); return readPending(all[key], key.slice(5)); });
    props.setProperty('IN_FLIGHT', '0');
    state = readState(props);
  } finally { lock.releaseLock(); }
  pending.forEach(function(item) {
    if (item.view === 'help') return;
    const view = viewMessage(item.view, state);
    const text = view.text + '\n\nНе удалось запустить проверку. Попробуйте позже.';
    if (item.messageId) safeEdit(item.chatId, item.messageId, text, view.keyboard);
    else safeSend(item.chatId, text, view.keyboard);
  });
}

function telegramApi(method, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new Error('Bot token unavailable');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
        muteHttpExceptions: true, timeoutSeconds: 15
      });
    } catch (error) { recordMetrics({telegramErrors: 1}); throw error; }
    if (response.getResponseCode() !== 429) break;
    let retryAfter = 1;
    try { retryAfter = Number(JSON.parse(response.getContentText()).parameters.retry_after) || 1; }
    catch (parseError) { retryAfter = 1; }
    Utilities.sleep(Math.min(10000, Math.max(1000, retryAfter * 1000)));
  }
  if (response.getResponseCode() !== 200) {
    recordMetrics({telegramErrors: 1});
    const error = new Error('Telegram API failed');
    error.status = response.getResponseCode();
    try { error.description = String(JSON.parse(response.getContentText()).description || ''); }
    catch (parseError) { error.description = ''; }
    throw error;
  }
  return JSON.parse(response.getContentText());
}

function splitMessage(message) {
  const lines = String(message).split('\n');
  const pieces = [];
  let part = '';
  lines.forEach(function(line) {
    while (line.length > 3900) {
      if (part) { pieces.push(part); part = ''; }
      pieces.push(line.slice(0, 3900));
      line = line.slice(3900);
    }
    if (part && part.length + line.length + 1 > 3900) { pieces.push(part); part = ''; }
    part += (part ? '\n' : '') + line;
  });
  if (part) pieces.push(part);
  return pieces;
}

function sendTelegram(chatId, message, keyboard) {
  const pieces = splitMessage(message);
  let lastMessageId = 0, sentPieces = 0;
  try {
    pieces.forEach(function(piece, index) {
      const payload = {chat_id: chatId, text: piece, disable_web_page_preview: true};
      if (keyboard && index === pieces.length - 1) payload.reply_markup = keyboard;
      const response = telegramApi('sendMessage', payload);
      lastMessageId = Number(response.result && response.result.message_id || 0);
      sentPieces++;
    });
  } finally { if (sentPieces) recordMetrics({messages: sentPieces}); }
  return lastMessageId;
}

function broadcastTelegram(chatIds, message, keyboard) {
  const recipients = unique(chatIds);
  const pieces = splitMessage(message);
  const deliveredParts = {};
  let directMessages = 0, directApiErrors = 0;
  function mark(chatId) { deliveredParts[chatId] = Number(deliveredParts[chatId] || 0) + 1; }
  function outcome() {
    const sent = recipients.filter(function(chatId) { return deliveredParts[chatId] === pieces.length; }).length;
    return {attempted: recipients.length, sent: sent, failed: recipients.length - sent};
  }
  if (recipients.length <= BROADCAST_BATCH_SIZE) {
    recipients.forEach(function(chatId) {
      if (safeSend(chatId, message, keyboard)) deliveredParts[chatId] = pieces.length;
    });
    return outcome();
  }
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new Error('Bot token unavailable');
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  for (let offset = 0; offset < recipients.length; offset += BROADCAST_BATCH_SIZE) {
    const batch = recipients.slice(offset, offset + BROADCAST_BATCH_SIZE);
    pieces.forEach(function(piece, partIndex) {
      const partKeyboard = partIndex === pieces.length - 1 ? keyboard : null;
      const requests = batch.map(function(chatId) {
        const payload = {chat_id: chatId, text: piece, disable_web_page_preview: true};
        if (partKeyboard) payload.reply_markup = partKeyboard;
        return {url: url, method: 'post', contentType: 'application/json',
          payload: JSON.stringify(payload), muteHttpExceptions: true, timeoutSeconds: 15};
      });
      let responses;
      try { responses = UrlFetchApp.fetchAll(requests); }
      catch (error) {
        console.error('Broadcast batch error: ' + String(error.name || 'Error'));
        directApiErrors++;
        recordError('Telegram рассылка', String(error.name || 'Error'));
        batch.forEach(function(chatId) {
          if (safeSend(chatId, piece, partKeyboard)) mark(chatId);
        });
        return;
      }
      responses.forEach(function(response, index) {
        const status = response.getResponseCode();
        if (status === 200) { mark(batch[index]); directMessages++; return; }
        directApiErrors++;
        if (status === 403) {
          PropertiesService.getScriptProperties().deleteProperty('SUB_' + batch[index]);
          return;
        }
        if (status === 429) {
          let retryAfter = 1;
          try { retryAfter = Number(JSON.parse(response.getContentText()).parameters.retry_after) || 1; }
          catch (parseError) { retryAfter = 1; }
          Utilities.sleep(Math.min(10000, Math.max(1000, retryAfter * 1000)));
        }
        if (safeSend(batch[index], piece, partKeyboard)) mark(batch[index]);
      });
      // Telegram's free broadcast limit is about 30 messages/s. Keep room for
      // commands arriving at the webhook while a broadcast is in progress.
      if (offset + batch.length < recipients.length || partIndex < pieces.length - 1) {
        Utilities.sleep(1000);
      }
    });
  }
  if (directMessages) recordMetrics({messages: directMessages});
  if (directApiErrors) recordMetrics({telegramErrors: directApiErrors});
  const result = outcome();
  if (result.failed) recordError('Telegram рассылка', result.failed + ' недоставлено');
  return result;
}

function editTelegram(chatId, messageId, message, keyboard) {
  if (!messageId) throw new Error('Missing message to edit');
  const payload = {chat_id: chatId, message_id: messageId, text: message,
    link_preview_options: {is_disabled: true}};
  if (keyboard) payload.reply_markup = keyboard;
  telegramApi('editMessageText', payload);
  recordMetrics({edits: 1});
}

function safeEdit(chatId, messageId, message, keyboard) {
  try { editTelegram(chatId, messageId, message, keyboard); }
  catch (error) {
    if (error.status === 400 && /message is not modified/i.test(error.description || '')) return;
    console.error('Telegram edit error: ' + String(error.status || error.name || 'Error'));
    recordError('Telegram edit', String(error.status || error.name || 'Error'));
    // A deleted or inaccessible old message cannot be edited; preserve the result.
    safeSend(chatId, message, keyboard);
  }
}

function safeSend(chatId, message, keyboard) {
  try { sendTelegram(chatId, message, keyboard); return true; }
  catch (error) {
    console.error('Telegram delivery error: ' + String(error.status || error.name || 'Error'));
    recordError('Telegram send', String(error.status || error.name || 'Error'));
    if (error.status === 403) {
      PropertiesService.getScriptProperties().deleteProperty('SUB_' + chatId);
      PropertiesService.getScriptProperties().deleteProperty('PEND_' + chatId);
    }
    return false;
  }
}

function safeAnswerCallback(queryId) {
  try { telegramApi('answerCallbackQuery', {callback_query_id: queryId}); }
  catch (error) {
    console.error('Callback answer error: ' + String(error.status || 'Error'));
    recordError('Telegram кнопка', String(error.status || error.name || 'Error'));
  }
}

function readSlots(props, eventKey) {
  const prefix = 'EV_' + eventKey.toUpperCase() + '_';
  const count = Number(props.getProperty(prefix + 'CHUNKS') || 0);
  if (!count) return [];
  let text = '';
  for (let i = 0; i < count; i++) text += props.getProperty(prefix + 'SLOT_' + i) || '';
  return JSON.parse(text);
}

function writeSlots(props, eventKey, slots) {
  const prefix = 'EV_' + eventKey.toUpperCase() + '_';
  const text = JSON.stringify(slots);
  const oldCount = Number(props.getProperty(prefix + 'CHUNKS') || 0);
  const chunks = text.match(/[\s\S]{1,7000}/g) || ['[]'];
  chunks.forEach(function(chunk, index) { props.setProperty(prefix + 'SLOT_' + index, chunk); });
  for (let i = chunks.length; i < oldCount; i++) props.deleteProperty(prefix + 'SLOT_' + i);
  props.setProperty(prefix + 'CHUNKS', String(chunks.length));
}

function hashSlots(slots) {
  const input = slots.map(function(slot) { return slot.id + ':' + slot.start; }).join('|');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input)
    .map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}

function hashText(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
    .map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}

function unique(items) {
  return items.filter(function(value, index) { return items.indexOf(value) === index; });
}

function metricsKey(now) {
  return 'METRIC_' + Utilities.formatDate(new Date(now), MOSCOW_TZ, 'yyyyMMdd');
}

function addMetricsLocked(props, changes, now) {
  const key = metricsKey(now || Date.now());
  let data;
  try { data = JSON.parse(props.getProperty(key) || '{}'); }
  catch (error) { data = {}; }
  Object.keys(changes).forEach(function(name) {
    const value = Number(changes[name]);
    if (Number.isFinite(value)) data[name] = Number(data[name] || 0) + value;
  });
  props.setProperty(key, JSON.stringify(data));
  if (!props.getProperty('METRICS_SINCE')) props.setProperty('METRICS_SINCE', new Date(now || Date.now()).toISOString());
}

function recordMetrics(changes) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try { addMetricsLocked(PropertiesService.getScriptProperties(), changes, Date.now()); }
    finally { lock.releaseLock(); }
  } catch (error) { console.error('Metrics write error: ' + String(error.name || 'Error')); }
}

function recordError(kind, detail) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const props = PropertiesService.getScriptProperties();
      appendErrorLocked(props, kind, detail);
    } finally { lock.releaseLock(); }
  } catch (error) { console.error('Error log write failed: ' + String(error.name || 'Error')); }
}

function appendErrorLocked(props, kind, detail) {
  addMetricsLocked(props, {errors: 1}, Date.now());
  let items;
  try { items = JSON.parse(props.getProperty('ADMIN_ERRORS') || '[]'); }
  catch (error) { items = []; }
  items.push({at: new Date().toISOString(), kind: kind, detail: String(detail || '').slice(0, 60)});
  props.setProperty('ADMIN_ERRORS', JSON.stringify(items.slice(-20)));
}

function scheduledDelayMs(startedAt) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started)) return 0;
  const day = Utilities.formatDate(new Date(started), MOSCOW_TZ, 'yyyy-MM-dd');
  const morning = Date.parse(day + 'T09:07:00+03:00');
  const evening = Date.parse(day + 'T21:07:00+03:00');
  const expected = started >= evening ? evening : started >= morning ? morning : evening - 86400000;
  const delay = started - expected;
  return delay >= 0 && delay < 6 * 3600000 ? delay : 0;
}

function trackUserLocked(props, chatId, user, action) {
  const key = 'USR_' + chatId;
  let profile;
  try { profile = JSON.parse(props.getProperty(key) || '{}'); }
  catch (error) { profile = {}; }
  if (user && typeof user === 'object') {
    const username = typeof user.username === 'string' ? user.username : '';
    profile.username = /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : '';
  }
  if (!profile.firstSeen) profile.firstSeen = new Date().toISOString();
  profile.lastSeen = new Date().toISOString();
  if (action === '/stop') profile.notificationsOff = true;
  if (action === '/start' || action === '/priority') profile.notificationsOff = false;
  props.setProperty(key, JSON.stringify(profile));
}

function readJson(value, fallback) {
  try { return JSON.parse(value || ''); }
  catch (error) { return fallback; }
}

function adminSnapshot(props) {
  const all = props.getProperties();
  const subscriberIds = Object.keys(all).filter(function(key) { return /^SUB_\d+$/.test(key); })
    .map(function(key) { return key.slice(4); });
  const profiles = {};
  Object.keys(all).filter(function(key) { return /^USR_\d+$/.test(key); }).forEach(function(key) {
    profiles[key.slice(4)] = readJson(all[key], {});
  });
  const ids = unique(subscriberIds.concat(Object.keys(profiles)));
  const subscriberSet = {};
  subscriberIds.forEach(function(id) { subscriberSet[id] = true; });
  const users = ids.map(function(id) {
    const profile = profiles[id] || {};
    return {id: id, username: profile.username || '', lastSeen: profile.lastSeen || '',
      active: !!subscriberSet[id], notificationsOff: !!profile.notificationsOff};
  }).sort(function(a, b) {
    return Number(!!b.username) - Number(!!a.username) || b.lastSeen.localeCompare(a.lastSeen);
  });
  const today = readJson(all[metricsKey(Date.now())], {});
  const total = {};
  Object.keys(all).filter(function(key) { return /^METRIC_\d{8}$/.test(key); }).forEach(function(key) {
    const day = readJson(all[key], {});
    Object.keys(day).forEach(function(name) { total[name] = Number(total[name] || 0) + Number(day[name] || 0); });
  });
  return {users: users, active: subscriberIds.length,
    disabled: users.filter(function(user) { return !user.active && user.notificationsOff; }).length,
    noSubscription: users.filter(function(user) { return !user.active; }).length,
    usernames: users.filter(function(user) { return !!user.username; }).length,
    today: today, total: total, since: all.METRICS_SINCE || '',
    lastCheck: readJson(all.METRICS_LAST_CHECK, {}),
    lastSchedule: readJson(all.METRICS_LAST_SCHEDULE, {}),
    lastManual: readJson(all.METRICS_LAST_MANUAL, {}),
    delivery: readJson(all.METRICS_DELIVERY, {}),
    pending: readJson(all.PRIORITY_PENDING, {}),
    errors: readJson(all.ADMIN_ERRORS, [])};
}

function metric(data, name) { return Number(data[name] || 0); }

function durationLabel(milliseconds) {
  const seconds = Math.round(Number(milliseconds || 0) / 1000);
  if (!seconds) return '—';
  return seconds < 60 ? seconds + ' с' : Math.floor(seconds / 60) + ' мин ' + (seconds % 60) + ' с';
}

function adminKeyboard(section, page, pages) {
  if (section === 'home') return {inline_keyboard: [
    [{text: 'Проверки', callback_data: 'admin_checks'}, {text: 'Ошибки', callback_data: 'admin_errors'}],
    [{text: 'Доставка', callback_data: 'admin_delivery'}, {text: 'Пользователи', callback_data: 'admin_users_0'}],
    [{text: 'Облачные запуски', callback_data: 'admin_cloud'}, {text: '↻ Обновить', callback_data: 'admin_home'}]
  ]};
  const rows = [];
  if (section === 'users' && pages > 1) {
    const buttons = [];
    if (page > 0) buttons.push({text: '←', callback_data: 'admin_users_' + (page - 1)});
    buttons.push({text: (page + 1) + '/' + pages, callback_data: 'admin_users_' + page});
    if (page < pages - 1) buttons.push({text: '→', callback_data: 'admin_users_' + (page + 1)});
    rows.push(buttons);
  }
  rows.push([{text: '← К сводке', callback_data: 'admin_home'},
    {text: '↻ Обновить', callback_data: section === 'users' ? 'admin_users_' + page : 'admin_' + section}]);
  if (section === 'errors' || section === 'cloud') rows.push([{text: 'Открыть GitHub',
    url: 'https://github.com/nenesashka/cu-wellbeing-slots/actions/workflows/check.yml'}]);
  return {inline_keyboard: rows};
}

function adminView(action, props) {
  const snapshot = adminSnapshot(props);
  const today = snapshot.today, total = snapshot.total;
  const since = snapshot.since ? dateLabel(snapshot.since) : 'сейчас';
  const section = action.indexOf('admin_users_') === 0 ? 'users' :
    action === 'admin_checks' ? 'checks' : action === 'admin_errors' ? 'errors' :
    action === 'admin_delivery' ? 'delivery' : action === 'admin_cloud' ? 'cloud' : 'home';
  if (section === 'home') return {text:
    '📊 Статистика бота\n\n' +
    'Пользователи\n' +
    'Активных подписчиков: ' + snapshot.active + '\n' +
    'Известных чатов: ' + snapshot.users.length + '\n' +
    'Отключили уведомления: ' + snapshot.disabled + '\n' +
    'Без подписки: ' + snapshot.noSubscription + '\n' +
    'Юзернеймов известно: ' + snapshot.usernames + '\n\n' +
    'Сегодня · Москва\n' +
    'Ручных запросов: ' + metric(today, 'manualRequests') + '\n' +
    'Проверок завершено: ' + metric(today, 'checks') + '\n' +
    'Ошибок: ' + metric(today, 'errors') + '\n' +
    'Ответов: ' + (metric(today, 'messages') + metric(today, 'edits')) + '\n\n' +
    'Учёт действий ведётся с ' + since + ' по Москве. Старые подписчики входят в счётчик, их прежние действия и юзернеймы неизвестны.',
    keyboard: adminKeyboard('home')};
  if (section === 'checks') {
    const last = snapshot.lastCheck, scheduled = snapshot.lastSchedule, manual = snapshot.lastManual;
    return {text: '🔎 Проверки\n\n' +
      'Сегодня: ' + metric(today, 'checks') + ' · вручную ' + metric(today, 'manualChecks') +
      ' · по расписанию ' + metric(today, 'scheduledChecks') + '\n' +
      'Запросов на ручную проверку: ' + metric(today, 'manualRequests') + '\n' +
      'Ошибок источников: ' + metric(today, 'sourceErrors') + '\n\n' +
      'Среднее время проверки: ' + durationLabel(metric(today, 'durationSumMs') /
        Math.max(1, metric(today, 'durationCount'))) + '\n' +
      'Среднее ожидание /check: ' + durationLabel(metric(today, 'manualWaitSumMs') /
        Math.max(1, metric(today, 'manualWaitCount'))) + '\n' +
      'Среднее от расписания до старта: ' + durationLabel(metric(today, 'scheduleDelaySumMs') /
        Math.max(1, metric(today, 'scheduleDelayCount'))) + '\n\n' +
      'С начала учёта: ' + metric(total, 'checks') + ' проверок · ' +
      metric(total, 'manualRequests') + ' ручных запросов\n\n' +
      'Последняя: ' + (last.checkedAt ? dateLabel(last.checkedAt) + ' МСК' : 'нет данных') + '\n' +
      'Тип: ' + (last.source === 'schedule' ? 'плановая' : last.source === 'workflow_dispatch' ? 'ручная' : '—') + '\n' +
      'Работа проверки: ' + durationLabel(last.durationMs) + '\n' +
      'Последнее от расписания до старта: ' + durationLabel(scheduled.scheduleDelayMs) + '\n' +
      'Последнее ожидание /check: ' + durationLabel(manual.manualWaitMs) + '\n' +
      'Светлана: ' + (last.svetlana || '—') + ' · Лилия: ' + (last.lilia || '—'),
      keyboard: adminKeyboard('checks')};
  }
  if (section === 'errors') {
    const errors = snapshot.errors.slice(-10).reverse();
    return {text: '⚠️ Ошибки\n\n' +
      'Сегодня: ' + metric(today, 'errors') + '\n' +
      'С начала учёта: ' + metric(total, 'errors') + '\n\n' +
      (errors.length ? errors.map(function(item) {
        return dateLabel(item.at) + ' · ' + item.kind + (item.detail ? ' (' + item.detail + ')' : '');
      }).join('\n') : 'Зафиксированных ошибок пока нет.') +
      '\n\nСбои GitHub до отправки результата видны в истории запусков.',
      keyboard: adminKeyboard('errors')};
  }
  if (section === 'delivery') {
    const delivery = snapshot.delivery, pending = snapshot.pending;
    return {text: '📨 Доставка\n\n' +
      'Сегодня: сообщений ' + metric(today, 'messages') + ', обновлений ' + metric(today, 'edits') +
      ', отправок общей рассылки ' + metric(today, 'broadcasts') + '\n' +
      'Адресатов общей рассылки: ' + metric(today, 'broadcastRecipients') + '\n' +
      'Ошибок Telegram: ' + metric(today, 'telegramErrors') + '\n\n' +
      'Последнее уведомление владельцу: ' + (delivery.ownerAt ? dateLabel(delivery.ownerAt) + ' МСК' : 'нет данных') + '\n' +
      'Доставка владельцу: ' + durationLabel(delivery.ownerLatencyMs) + '\n' +
      'Последняя общая рассылка: ' + (delivery.generalAt ? dateLabel(delivery.generalAt) + ' МСК' : 'нет данных') + '\n' +
      'Время общей рассылки: ' + durationLabel(delivery.generalDurationMs) + '\n' +
      'Получателей: ' + metric(delivery, 'generalRecipients') + '\n' +
      'Ожидает отправки остальным: ' + (pending.dueAt ? dateLabel(pending.dueAt) + ' МСК' : 'нет'),
      keyboard: adminKeyboard('delivery')};
  }
  if (section === 'cloud') return {text: githubRunsReport(props), keyboard: adminKeyboard('cloud')};
  const pages = Math.max(1, Math.ceil(snapshot.users.length / 15));
  const requestedPage = Number(action.slice('admin_users_'.length)) || 0;
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const users = snapshot.users.slice(page * 15, page * 15 + 15);
  return {text: '👥 Пользователи · ' + (page + 1) + '/' + pages + '\n\n' +
    (users.length ? users.map(function(user) {
      const label = user.username ? '@' + user.username : 'ID ' + user.id;
      return (user.active ? '🔔 ' : user.notificationsOff ? '🔕 ' : '○ ') + label +
        (user.lastSeen ? ' · ' + dateLabel(user.lastSeen) : ' · прежняя подписка');
    }).join('\n') : 'Пользователей пока нет.') +
    '\n\nЮзернеймы Telegram необязательны. Для старых подписок имя появится после следующего обращения к боту.',
    keyboard: adminKeyboard('users', page, pages)};
}

function githubRunsReport(props) {
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) return '☁️ Облачные запуски\n\nНе настроен доступ к GitHub.';
  try {
    const response = UrlFetchApp.fetch(
      'https://api.github.com/repos/nenesashka/cu-wellbeing-slots/actions/workflows/check.yml/runs?per_page=15', {
        headers: {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
          'User-Agent': 'CU-CareSlot-admin', 'X-GitHub-Api-Version': '2022-11-28'},
        muteHttpExceptions: true, timeoutSeconds: 10
      });
    if (response.getResponseCode() !== 200) throw new Error('HTTP ' + response.getResponseCode());
    const runs = JSON.parse(response.getContentText()).workflow_runs || [];
    const failed = runs.filter(function(run) { return run.conclusion === 'failure'; }).length;
    return '☁️ Облачные запуски\n\nНеудачных среди последних ' + runs.length + ': ' + failed + '\n\n' +
      (runs.length ? runs.slice(0, 10).map(function(run) {
        const icon = run.conclusion === 'success' ? '✓' : run.conclusion === 'failure' ? '✕' : '…';
        const kind = run.event === 'schedule' ? 'плановая' : 'ручная';
        return icon + ' ' + dateLabel(run.created_at) + ' · ' + kind + ' · ' +
          (run.conclusion || run.status || '—');
      }).join('\n') : 'Запусков пока нет.');
  } catch (error) {
    recordError('GitHub статистика', String(error.message || error.name || 'Error'));
    return '☁️ Облачные запуски\n\nНе удалось загрузить историю. Нажми «Открыть GitHub».';
  }
}

function configureBotProfile() {
  telegramApi('setMyName', {name: 'CU CareSlot', language_code: 'ru'});
  telegramApi('setMyCommands', {commands: [
    {command: 'check', description: 'Проверить свободное время'},
    {command: 'svetlana', description: 'Светлана — очно'},
    {command: 'lilia', description: 'Лилия — онлайн'},
    {command: 'help', description: 'Как пользоваться ботом'},
    {command: 'start', description: 'Включить уведомления'},
    {command: 'stop', description: 'Отключить уведомления'}
  ]});
  telegramApi('setMyDescription', {description: 'CU CareSlot следит за записью к двум психологам ЦУ: Светлане Шутьковой (очно) и Лилии Павловой (онлайн). Бот дважды в день проверяет свободные даты и время и сообщает об изменениях. Команда /check запускает дополнительную проверку.', language_code: 'ru'});
  telegramApi('setMyShortDescription', {short_description: 'Свободное время к психологам ЦУ: Светлана очно, Лилия онлайн.', language_code: 'ru'});
}

function maybeConfigureBotProfile(props) {
  if (props.getProperty('PROFILE_VERSION') === '2') return;
  try {
    configureBotProfile();
    props.setProperty('PROFILE_VERSION', '2');
  } catch (error) {
    console.error('Bot profile update error: ' + String(error.status || error.name || 'Error'));
    recordError('Профиль бота', String(error.status || error.name || 'Error'));
  }
}
