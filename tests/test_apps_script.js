const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const values = {'SUB_101': '1'};
const props = {
  getProperty: key => values[key] ?? null,
  setProperty: (key, value) => { values[key] = String(value); },
  deleteProperty: key => { delete values[key]; },
  getProperties: () => ({...values})
};
const calls = [];
let nextMessageId = 500;
let dispatches = 0;
const triggers = [];
const context = {
  console,
  PropertiesService: {getScriptProperties: () => props},
  LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
  ScriptApp: {
    getProjectTriggers: () => triggers,
    newTrigger(name) { return {timeBased() { return this; }, after(delay) {
      this.delay = delay; return this;
    }, create() { const trigger = {getHandlerFunction: () => name,
      getUniqueId: () => String(triggers.length + 1), delay: this.delay};
      triggers.push(trigger); return trigger; }}; },
    deleteTrigger(trigger) { const index = triggers.indexOf(trigger); if (index >= 0) triggers.splice(index, 1); }
  },
  Utilities: {
    computeDigest(_algorithm, input) { return [...crypto.createHash('sha256').update(input).digest()]; },
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    formatDate(date, _zone, format) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).map(x => [x.type, x.value]));
      return ({'yyyy-MM-dd': `${p.year}-${p.month}-${p.day}`,
        yyyyMMdd: `${p.year}${p.month}${p.day}`, d: String(Number(p.day)),
        M: String(Number(p.month)), yyyy: p.year, 'HH:mm': `${p.hour}:${p.minute}`,
        'dd.MM.yyyy HH:mm': `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`})[format];
    }
  }
};
vm.createContext(context);
const testPairingCode = 'a'.repeat(32);
const testPairingHash = crypto.createHash('sha256').update(testPairingCode).digest('hex');
const source = fs.readFileSync(path.join(__dirname, '../appsscript/Code.gs'), 'utf8')
  .replace(/const PRIORITY_PAIRING_HASH = '[a-f0-9]+';/,
    `const PRIORITY_PAIRING_HASH = '${testPairingHash}';`);
vm.runInContext(source, context);
context.telegramApi = (method, payload) => {
  const result = method === 'sendMessage' ? {message_id: nextMessageId++} : true;
  calls.push({method, payload, result});
  return {ok: true, result};
};
context.dispatchCheck = () => { dispatches++; };
const messages = () => calls.filter(x => x.method === 'sendMessage');
const edits = () => calls.filter(x => x.method === 'editMessageText');
context.handleTelegram({update_id: 1, message: {chat: {id: 101, type: 'private'},
  text: '/priority ' + testPairingCode}}, props);
assert.equal(values.PRIORITY_CHAT_ID, '101', 'pairing binds priority to the requesting chat');
assert.match(messages()[0].payload.text, /Приоритетные уведомления включены/);
calls.length = 0;
context.handleTelegram({update_id: 2, message: {chat: {id: 999, type: 'private'},
  text: '/priority ' + testPairingCode}}, props);
assert.equal(values.PRIORITY_CHAT_ID, '101', 'a second chat cannot replace the owner');
assert.match(messages()[0].payload.text, /Не удалось включить приоритет/);
calls.length = 0;
context.handleTelegram({update_id: 3, message: {chat: {id: 101, type: 'private'},
  text: '/stats'}}, props);
assert.match(messages()[0].payload.text, /Активных подписчиков: 1/);
const adminMessageId = messages()[0].result.message_id;
assert.equal(dispatches, 0, 'stats must not launch a slot check');
calls.length = 0;
context.handleTelegram({update_id: 4, message: {chat: {id: 999, type: 'private'},
  text: '/stats'}}, props);
assert.equal(messages()[0].payload.text, 'Команда недоступна.');
calls.length = 0;
const now = new Date();
const checkedAt = seconds => new Date(now.getTime() + seconds * 1000).toISOString();
assert.equal(context.scheduledDelayMs('2026-10-25T06:39:14Z'), (32 * 60 + 14) * 1000);
const base = {
  checked_at: checkedAt(0),
  source: 'schedule',
  events: {
    svetlana: {registration_open: true, slots: [
      {id: '1', start: '2030-11-16T11:15:00+03:00'},
      {id: '2', start: '2030-11-16T14:00:00+03:00'}
    ]},
    lilia: {registration_open: false, slots: []}
  }
};

function releaseDelayed() {
  const queued = JSON.parse(values.PRIORITY_PENDING);
  assert(queued.dueAt >= queued.sentAt + 60 * 60 * 1000);
  queued.dueAt = Date.now() - 1;
  values.PRIORITY_PENDING = JSON.stringify(queued);
  context.deliverDelayedBroadcast({triggerUid: triggers[0].getUniqueId()});
}

// First scheduled result goes to the priority subscriber immediately.
context.handleWorkflow(base, props);
assert.equal(messages().length, 1);
assert.equal(messages()[0].payload.chat_id, '101');
assert.equal(triggers.length, 1);
assert.match(messages()[0].payload.text, /^Свободные слоты к психологам/);
assert.doesNotMatch(messages()[0].payload.text, /^CU CareSlot/);
assert.match(messages()[0].payload.text, /16 ноября 2030 — 11:15, 14:00/);
assert.match(messages()[0].payload.text, /Лилия Павлова · онлайн\nРегистрация пока закрыта/);
const mainButtons = messages()[0].payload.reply_markup.inline_keyboard;
assert.equal(mainButtons[1][0].text, 'Страница Светланы');
assert.equal(mainButtons[2][0].text, 'Страница Лилии');
assert.equal(mainButtons[3][0].callback_data, 'help');
assert.equal(mainButtons.flat().some(button => ['svetlana', 'lilia'].includes(button.callback_data)), false);
assert.equal(calls.filter(x => x.method === 'setMyCommands').length, 1);
calls.length = 0;
context.deliverDelayedBroadcast({triggerUid: triggers[0].getUniqueId()});
assert.equal(messages().length, 0, 'other users receive nothing before the full hour');
assert.equal(triggers.length, 1, 'an early trigger is rescheduled');
releaseDelayed();
assert.equal(triggers.length, 0);
calls.length = 0;
context.handleWorkflow(base, props);
assert.equal(calls.length, 0, 'duplicate workflow result stays quiet');

// Any user can subscribe. Help and Back edit the same message.
context.handleTelegram({update_id: 298, message: {chat: {id: 303, type: 'private'},
  from: {id: 303, username: 'student303'}, text: '/start'}}, props);
assert.equal(values.SUB_303, '1');
const menuId = messages()[0].result.message_id;
calls.length = 0;
context.handleTelegram({update_id: 2981, message: {chat: {id: 101, type: 'private'},
  text: '/stats'}}, props);
assert.match(messages()[0].payload.text, /Активных подписчиков: 2/);
calls.length = 0;
context.handleTelegram({update_id: 299, callback_query: {id: 'view-help', data: 'help',
  message: {chat: {id: 303, type: 'private'}, message_id: menuId}}}, props);
assert.equal(calls[0].method, 'answerCallbackQuery');
assert.equal(edits().length, 1);
assert.equal(messages().length, 0);
assert.equal(edits()[0].payload.message_id, menuId);
assert.match(edits()[0].payload.text, /^Как пользоваться ботом/);
assert.equal(edits()[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'all');
calls.length = 0;
context.handleTelegram({update_id: 2991, callback_query: {id: 'back-to-slots', data: 'all',
  message: {chat: {id: 303, type: 'private'}, message_id: menuId}}}, props);
assert.equal(messages().length, 0);
assert.equal(edits().length, 1);
assert.equal(edits()[0].payload.message_id, menuId);
assert.match(edits()[0].payload.text, /^Свободные слоты к психологам/);

// Checking from an inline button edits that message, then edits it again with fresh data.
calls.length = 0;
context.handleTelegram({update_id: 300, callback_query: {id: 'check-slots', data: 'check',
  message: {chat: {id: 303, type: 'private'}, message_id: menuId}}}, props);
assert.equal(dispatches, 1);
assert.equal(edits().length, 1);
assert.equal(messages().length, 0);
assert.match(edits()[0].payload.text, /Проверяю страницы/);
assert.equal(JSON.parse(values.PEND_303).messageId, menuId);
assert.equal(JSON.parse(values.PEND_303).view, 'all');
const callCount = calls.length;
context.handleTelegram({update_id: 300, callback_query: {id: 'check-slots', data: 'check',
  message: {chat: {id: 303, type: 'private'}, message_id: menuId}}}, props);
assert.equal(calls.length, callCount + 1, 'duplicate callback is acknowledged but not processed');
assert.equal(dispatches, 1);

calls.length = 0;
const changed = {...base, checked_at: checkedAt(1), events: {...base.events,
  lilia: {registration_open: true, slots: [{id: '3', start: '2030-11-17T16:30:00+03:00'}]}}};
context.handleWorkflow({...changed, source: 'workflow_dispatch'}, props);
assert.equal(messages().length, 0, 'manual check must never notify another subscriber');
assert.equal(edits().length, 1, 'requester sees the existing message updated');
assert.equal(edits()[0].payload.chat_id, '303');
assert.equal(edits()[0].payload.message_id, menuId);
assert.match(edits()[0].payload.text, /Лилия Павлова · онлайн\n17 ноября 2030 — 16:30/);
assert.match(edits()[0].payload.text, /Светлана Шутькова/);
assert.doesNotMatch(edits()[0].payload.text, /Проверяю страницы/);

// A typed /check gets one bot message, which is edited after an unchanged check.
calls.length = 0;
context.handleTelegram({update_id: 301, message: {chat: {id: 202, type: 'private'}, text: '/check'}}, props);
assert.equal(dispatches, 2);
assert.equal(messages().length, 1);
const commandMessageId = messages()[0].result.message_id;
assert.equal(JSON.parse(values.PEND_202).messageId, commandMessageId);
calls.length = 0;
context.handleWorkflow({...changed, checked_at: checkedAt(2), source: 'workflow_dispatch'}, props);
assert.equal(messages().length, 0, 'unchanged check must not send another message');
assert.equal(edits().length, 1);
assert.equal(edits()[0].payload.message_id, commandMessageId);
assert.doesNotMatch(edits()[0].payload.text, /Проверяю страницы/);

// A scheduled check broadcasts the change found by a manual check, once.
calls.length = 0;
context.handleWorkflow({...changed, checked_at: checkedAt(3), source: 'schedule'}, props);
assert.equal(messages().length, 1, 'scheduled change first reaches only the owner');
assert.equal(messages()[0].payload.chat_id, '101');
calls.length = 0;
releaseDelayed();
assert.deepEqual(messages().map(x => x.payload.chat_id), ['303']);
calls.length = 0;
context.handleWorkflow({...changed, checked_at: checkedAt(4), source: 'schedule'}, props);
assert.equal(messages().length, 0, 'unchanged scheduled result stays quiet');

// Missing or unknown source must also fail closed, even when availability changes.
calls.length = 0;
const changedAgain = {...changed, checked_at: checkedAt(5), source: undefined, events: {...changed.events,
  lilia: {registration_open: false, slots: []}}};
context.handleWorkflow(changedAgain, props);
assert.equal(messages().length, 0, 'unclassified check cannot broadcast');
context.handleWorkflow({...changedAgain, checked_at: checkedAt(6), source: 'schedule'}, props);
assert.equal(messages().length, 1, 'next scheduled check first delivers to the owner');
assert.equal(messages()[0].payload.chat_id, '101');
calls.length = 0;
releaseDelayed();
assert.deepEqual(messages().map(x => x.payload.chat_id), ['303']);

// Simulate a broadcast to 700 subscribers without sending real Telegram messages.
values.BOT_TOKEN = 'test-token';
values.GITHUB_TOKEN = 'test-token';
const batches = [];
const pauses = [];
context.Utilities.sleep = ms => { pauses.push(ms); };
context.UrlFetchApp = {fetchAll(requests) {
  batches.push(requests);
  return requests.map(() => ({getResponseCode: () => 200}));
}};
calls.length = 0;
context.broadcastTelegram(Array.from({length: 700}, (_, i) => String(1000 + i)),
  'Свободные слоты к психологам', context.menuKeyboard());
assert.equal(batches.length, Math.ceil(700 / 12));
assert.equal(batches.reduce((sum, batch) => sum + batch.length, 0), 700);
assert(batches.every(batch => batch.length <= 12 && batch.every(request => request.timeoutSeconds === 15)));
assert.equal(pauses.length, batches.length - 1);
assert(pauses.every(ms => ms >= 1000));
assert.equal(messages().length, 0, 'large broadcast uses paced batches');

calls.length = 0;
context.handleTelegram({update_id: 500, message: {chat: {id: 303, type: 'private'},
  from: {id: 303, username: 'student303'}, text: '/stop'}}, props);
context.handleTelegram({update_id: 501, message: {chat: {id: 101, type: 'private'}, text: '/stats'}}, props);
assert.match(messages()[1].payload.text, /Активных подписчиков: 1/,
  'the count drops when a user disables notifications');

calls.length = 0;
const failed = {...changedAgain, checked_at: checkedAt(7), source: 'workflow_dispatch',
  events: {...changedAgain.events, lilia: {error: 'source_unavailable'}}};
context.handleWorkflow(failed, props);
context.handleTelegram({update_id: 502, callback_query: {id: 'admin-errors',
  from: {id: 101}, data: 'admin_errors',
  message: {chat: {id: 101, type: 'private'}, message_id: adminMessageId}}}, props);
assert.equal(messages().length, 0, 'admin navigation edits the current message');
assert.equal(edits().length, 1);
assert.match(edits()[0].payload.text, /Лилия Павлова/);
assert.match(edits()[0].payload.text, /Сегодня: 1/);
calls.length = 0;
context.handleTelegram({update_id: 5021, callback_query: {id: 'admin-checks',
  from: {id: 101}, data: 'admin_checks',
  message: {chat: {id: 101, type: 'private'}, message_id: adminMessageId}}}, props);
assert.match(edits()[0].payload.text, /Запросов на ручную проверку: 2/);
assert.match(edits()[0].payload.text, /Ошибок источников: 1/);

context.UrlFetchApp.fetch = () => ({getResponseCode: () => 200, getContentText: () =>
  JSON.stringify({workflow_runs: [{created_at: checkedAt(0), event: 'schedule',
    conclusion: 'failure', status: 'completed'}]})});
calls.length = 0;
context.handleTelegram({update_id: 5022, callback_query: {id: 'admin-cloud',
  from: {id: 101}, data: 'admin_cloud',
  message: {chat: {id: 101, type: 'private'}, message_id: adminMessageId}}}, props);
assert.match(edits()[0].payload.text, /Неудачных среди последних 1: 1/);

calls.length = 0;
context.handleTelegram({update_id: 503, callback_query: {id: 'admin-users',
  from: {id: 101}, data: 'admin_users_0',
  message: {chat: {id: 101, type: 'private'}, message_id: adminMessageId}}}, props);
assert.match(edits()[0].payload.text, /@student303/);
assert.match(edits()[0].payload.text, /🔕/);
for (let index = 0; index < 20; index++) {
  values['USR_' + (1000 + index)] = JSON.stringify({username: 'reader_' + index,
    firstSeen: checkedAt(0), lastSeen: checkedAt(index)});
}
calls.length = 0;
context.handleTelegram({update_id: 5031, callback_query: {id: 'admin-users-next',
  from: {id: 101}, data: 'admin_users_1',
  message: {chat: {id: 101, type: 'private'}, message_id: adminMessageId}}}, props);
assert.match(edits()[0].payload.text, /Пользователи · 2\/2/);
assert.equal(messages().length, 0);
for (let index = 0; index < 700; index++) {
  values['USR_' + (2000 + index)] = JSON.stringify({username: 'member_' + index,
    firstSeen: checkedAt(0), lastSeen: checkedAt(0)});
}
const lastPage = Math.ceil(context.adminSnapshot(props).users.length / 15) - 1;
calls.length = 0;
context.handleTelegram({update_id: 5032, callback_query: {id: 'admin-users-last',
  from: {id: 101}, data: 'admin_users_' + lastPage,
  message: {chat: {id: 101, type: 'private'}, message_id: adminMessageId}}}, props);
assert.match(edits()[0].payload.text, new RegExp('Пользователи · ' + (lastPage + 1) + '/' + (lastPage + 1)));
assert(edits()[0].payload.text.length < 3900, 'large user directory fits in one Telegram message');
calls.length = 0;
context.handleTelegram({update_id: 504, callback_query: {id: 'admin-denied',
  from: {id: 999}, data: 'admin_users_0',
  message: {chat: {id: 999, type: 'private'}, message_id: adminMessageId}}}, props);
assert.equal(edits().length, 0, 'other users cannot open admin pages');

console.log('Apps Script integration tests passed');
