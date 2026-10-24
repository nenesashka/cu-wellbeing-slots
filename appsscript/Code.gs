/** CU CareSlot: Telegram webhook, subscriber store, and two-event results. */
const GITHUB_DISPATCH_URL = 'https://api.github.com/repos/nenesashka/cu-wellbeing-slots/actions/workflows/check.yml/dispatches';
const MOSCOW_TZ = 'Europe/Moscow';
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
  const messageId = callback ? Number(message.message_id || 0) : 0;
  const action = callback ? String(callback.data || '') :
    String(message.text || '').trim().split(/\s+/)[0].split('@')[0];
  const allowed = ['/start', '/check', '/help', '/stop', '/svetlana', '/lilia',
    'check', 'check_svetlana', 'check_lilia', 'all', 'svetlana', 'lilia', 'help'];
  const checkView = action === 'check_svetlana' ? 'svetlana' :
    action === 'check_lilia' ? 'lilia' : 'all';
  const isCheck = action === '/check' || action === 'check' ||
    action === 'check_svetlana' || action === 'check_lilia';
  if (callback) safeAnswerCallback(callback.id);
  if (allowed.indexOf(action) < 0) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let state, dispatchNeeded = false, requestCheck = false;
  try {
    const seen = JSON.parse(props.getProperty('RECENT_UPDATES') || '[]');
    const updateId = String(update.update_id);
    if (seen.indexOf(updateId) !== -1) return;
    seen.push(updateId);
    props.setProperty('RECENT_UPDATES', JSON.stringify(seen.slice(-180)));
    if (action === '/start') props.setProperty('SUB_' + chatId, '1');
    if (action === '/stop') {
      props.deleteProperty('SUB_' + chatId);
      props.deleteProperty('PEND_' + chatId);
    }
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
    } else if (callback && props.getProperty('PEND_' + chatId)) {
      const pending = readPending(props.getProperty('PEND_' + chatId), chatId);
      pending.messageId = messageId;
      pending.view = action;
      props.setProperty('PEND_' + chatId, JSON.stringify(pending));
    }
  } finally {
    lock.releaseLock();
  }

  if (callback && !isCheck) {
    const view = viewMessage(action, state);
    safeEdit(chatId, messageId, view.text, view.keyboard);
    return;
  }

  if (action === '/stop') {
    sendTelegram(chatId, 'Уведомления отключены. Проверять слоты вручную можно командой /check. Чтобы снова подписаться, отправьте /start.', menuKeyboard());
  } else if (action === '/help') {
    sendTelegram(chatId, helpText(), menuKeyboard());
  } else if (action === '/start') {
    const sentId = sendTelegram(chatId, welcomeText() + '\n\n' + formatReport(state) +
      (requestCheck ? '\n\nПроверяю страницы…' : ''), menuKeyboard());
    if (requestCheck) savePendingMessageId(props, chatId, sentId);
    if (dispatchNeeded) {
      try { dispatchCheck(props); }
      catch (error) { failDispatch(props); }
    }
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
      catch (error) { failDispatch(props); }
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
  const result = {checkedAt: checkedAt.toISOString(), events: {}};
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
  let subscribers, pending, changed = false, state;
  try {
    const previousResult = props.getProperty('LAST_WORKFLOW_CHECKED_AT') || '';
    if (previousResult && Date.parse(result.checkedAt) <= Date.parse(previousResult)) return;
    const all = props.getProperties();
    subscribers = Object.keys(all).filter(function(key) { return /^SUB_\d+$/.test(key); })
      .map(function(key) { return key.slice(4); });
    pending = Object.keys(all).filter(function(key) { return /^PEND_\d+$/.test(key); })
      .map(function(key) { return readPending(all[key], key.slice(5)); });
    EVENTS.forEach(function(event) {
      const item = result.events[event.key];
      const prefix = 'EV_' + event.key.toUpperCase() + '_';
      const previous = props.getProperty(prefix + 'STATUS') || 'unknown';
      if (item.error) {
        if (previous !== 'error') changed = true;
        props.setProperty(prefix + 'STATUS', 'error');
      } else {
        const status = item.registrationOpen ? 'open' : 'closed';
        const signature = hashSlots(item.slots) + ':' + status;
        if (signature !== props.getProperty(prefix + 'SIGNATURE') || previous === 'error') changed = true;
        props.setProperty(prefix + 'STATUS', status);
        props.setProperty(prefix + 'SIGNATURE', signature);
        props.setProperty(prefix + 'CHECKED_AT', result.checkedAt);
        writeSlots(props, event.key, item.slots);
      }
    });
    pending.forEach(function(item) { props.deleteProperty('PEND_' + item.chatId); });
    props.setProperty('IN_FLIGHT', '0');
    props.setProperty('LAST_WORKFLOW_CHECKED_AT', result.checkedAt);
    state = readState(props);
  } finally {
    lock.releaseLock();
  }
  if (changed) {
    const report = formatReport(state);
    const pendingIds = pending.filter(function(item) { return item.view !== 'help'; })
      .map(function(item) { return item.chatId; });
    subscribers.filter(function(chatId) { return pendingIds.indexOf(chatId) < 0; }).forEach(function(chatId) {
      safeSend(chatId, report, menuKeyboard());
    });
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
  return 'Как пользоваться ботом\n\nНажмите «Обновить», чтобы проверить обе записи. Кнопки с именами покажут слоты каждого психолога прямо в этом сообщении.\n\n/check — проверить обе записи\n/svetlana — очно\n/lilia — онлайн\n/start — включить уведомления\n/stop — отключить уведомления\n\nВремя московское. Запись оформляется на Timepad.';
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
  if (view === 'help') return {text: helpText(), keyboard: menuKeyboard()};
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
    [{text: 'Светлана', callback_data: 'svetlana'}, {text: 'Лилия', callback_data: 'lilia'}],
    [{text: 'Страница Светланы', url: EVENTS[0].url}],
    [{text: 'Страница Лилии', url: EVENTS[1].url}],
    [{text: 'Как это работает', callback_data: 'help'}]
  ]};
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
    muteHttpExceptions: true,
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
    response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 429) break;
    Utilities.sleep(1500);
  }
  if (response.getResponseCode() !== 200) {
    const error = new Error('Telegram API failed');
    error.status = response.getResponseCode();
    try { error.description = String(JSON.parse(response.getContentText()).description || ''); }
    catch (parseError) { error.description = ''; }
    throw error;
  }
  return JSON.parse(response.getContentText());
}

function sendTelegram(chatId, message, keyboard) {
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
  let lastMessageId = 0;
  pieces.forEach(function(piece, index) {
    const payload = {chat_id: chatId, text: piece, disable_web_page_preview: true};
    if (keyboard && index === pieces.length - 1) payload.reply_markup = keyboard;
    const response = telegramApi('sendMessage', payload);
    lastMessageId = Number(response.result && response.result.message_id || 0);
  });
  return lastMessageId;
}

function editTelegram(chatId, messageId, message, keyboard) {
  if (!messageId) throw new Error('Missing message to edit');
  const payload = {chat_id: chatId, message_id: messageId, text: message,
    link_preview_options: {is_disabled: true}};
  if (keyboard) payload.reply_markup = keyboard;
  telegramApi('editMessageText', payload);
}

function safeEdit(chatId, messageId, message, keyboard) {
  try { editTelegram(chatId, messageId, message, keyboard); }
  catch (error) {
    if (error.status === 400 && /message is not modified/i.test(error.description || '')) return;
    console.error('Telegram edit error: ' + String(error.status || error.name || 'Error'));
    // A deleted or inaccessible old message cannot be edited; preserve the result.
    safeSend(chatId, message, keyboard);
  }
}

function safeSend(chatId, message, keyboard) {
  try { sendTelegram(chatId, message, keyboard); }
  catch (error) {
    console.error('Telegram delivery error: ' + String(error.status || error.name || 'Error'));
    if (error.status === 403) {
      PropertiesService.getScriptProperties().deleteProperty('SUB_' + chatId);
      PropertiesService.getScriptProperties().deleteProperty('PEND_' + chatId);
    }
  }
}

function safeAnswerCallback(queryId) {
  try { telegramApi('answerCallbackQuery', {callback_query_id: queryId}); }
  catch (error) { console.error('Callback answer error: ' + String(error.status || 'Error')); }
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

function unique(items) {
  return items.filter(function(value, index) { return items.indexOf(value) === index; });
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
  }
}
