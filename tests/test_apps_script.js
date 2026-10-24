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
const sent = [];
let dispatches = 0;
const context = {
  console,
  PropertiesService: {getScriptProperties: () => props},
  LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
  Utilities: {
    computeDigest(_algorithm, input) { return [...crypto.createHash('sha256').update(input).digest()]; },
    DigestAlgorithm: {SHA_256: 'SHA_256'},
    formatDate(date, _zone, format) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).map(x => [x.type, x.value]));
      return ({'yyyy-MM-dd': `${p.year}-${p.month}-${p.day}`, d: String(Number(p.day)),
        M: String(Number(p.month)), yyyy: p.year, 'HH:mm': `${p.hour}:${p.minute}`,
        'dd.MM.yyyy HH:mm': `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`})[format];
    }
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../appsscript/Code.gs'), 'utf8'), context);
context.telegramApi = (method, payload) => { sent.push({method, payload}); return {ok: true}; };
context.dispatchCheck = () => { dispatches++; };

const payload = {
  checked_at: new Date().toISOString(),
  events: {
    svetlana: {registration_open: true, slots: [
      {id: '1', start: '2030-11-16T11:15:00+03:00'},
      {id: '2', start: '2030-11-16T14:00:00+03:00'}
    ]},
    lilia: {registration_open: false, slots: []}
  }
};
context.handleWorkflow(payload, props);
assert.equal(sent.filter(x => x.method === 'sendMessage').length, 1);
const first = sent[0].payload;
assert.match(first.text, /Светлана Шутькова · очно/);
assert.match(first.text, /Лилия Павлова · онлайн/);
assert.match(first.text, /16 ноября 2030 — 11:15, 14:00/);
assert.match(first.text, /Регистрация пока закрыта/);
assert.equal(first.reply_markup.inline_keyboard[2][1].url, 'https://cu-events.timepad.ru/event/3558805/');

sent.length = 0;
context.handleWorkflow(payload, props);
assert.equal(sent.length, 0, 'unchanged scheduled check must stay quiet');

context.handleTelegram({update_id: 300, message: {chat: {id: 202, type: 'private'}, text: '/check'}}, props);
assert.equal(dispatches, 1);
assert.equal(values.PEND_202, '1');
assert.match(sent.at(-1).payload.text, /Обновляю данные/);
const afterCheck = sent.length;
context.handleTelegram({update_id: 300, message: {chat: {id: 202, type: 'private'}, text: '/check'}}, props);
assert.equal(sent.length, afterCheck, 'duplicate Telegram update must not send again');
assert.equal(dispatches, 1);

sent.length = 0;
context.handleWorkflow({...payload, checked_at: new Date(Date.now() + 1000).toISOString(),
  events: {...payload.events, lilia: {error: 'source_unavailable'}}}, props);
assert.equal(values.EV_LILIA_STATUS, 'error');
assert.equal(values.EV_SVETLANA_STATUS, 'open');
assert.equal(values.PEND_202, undefined);
assert.equal(sent.filter(x => x.method === 'sendMessage').length, 2, 'subscriber and requester get one result each');
assert.match(sent[0].payload.text, /Не удалось обновить данные/);
assert.doesNotMatch(sent[0].payload.text, /Регистрация пока закрыта/);

sent.length = 0;
context.handleWorkflow({...payload, checked_at: values.LAST_WORKFLOW_CHECKED_AT,
  events: {...payload.events, lilia: {error: 'source_unavailable'}}}, props);
assert.equal(sent.length, 0, 'duplicate workflow callback must be ignored');

console.log('Apps Script integration tests passed');
