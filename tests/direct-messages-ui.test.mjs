// DIRECT-MESSAGES in the Hub's Crew chat: a "Direct messages" list with a "+ New message" picker over the team list,
// one conversation per person, unread counts, and sends to /api/employee-hub as directMessages addressed to that person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hubPage } from './helpers/hub-dom.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const collections = () => Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads', 'directMessages'].map(name => [name, []]));
const ROSTER = [{ username: 'crew.one', displayName: 'Synthetic Crew One' }, { username: 'Eli.Lead', displayName: 'Synthetic Eli' }, { username: 'AlexK', displayName: 'Synthetic Alex' }];
const CHANNEL = 'dm:crew.one|eli.lead';
const hubApi = url => {
  if (url.startsWith('/api/highlevel?view=command')) return json({ ok: true, pipelines: [], opportunities: [] });
  if (url.startsWith('/api/highlevel?view=walkthroughs')) return json({ ok: true, events: [] });
  if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: collections(), chatRoster: ROSTER });
  if (url.startsWith('/api/integration-status')) return json({ ok: true, status: { highlevel: true } });
  return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
};
async function crewPage(fetcher = hubApi) {
  const page = hubPage({ user: 'crew.one', business: false, role: 'crew', fetcher });
  page.api.S.peopleState.loaded = true;
  page.api.S.accountState.loaded = true;
  page.api.install(); await page.flush();
  return page;
}

test('a crew member starts a direct message with anyone on the team list and sends it to that person only', async () => {
  const sent = [];
  const page = await crewPage(async (url, init = {}) => {
    if (init.method === 'POST') { const body = JSON.parse(init.body); sent.push(body); return json({ ok: true, record: body.data }); }
    return hubApi(url);
  });
  page.api.S.people.chatRoster = ROSTER;
  page.api.go('crew_chat');
  const aside = page.main().querySelector('.ops-chat-layout aside');
  assert.match(aside.textContent, /DIRECT MESSAGES/);
  assert.match(aside.textContent, /\+ New message/);

  const opened = page.context.opsNewDirect();
  const asked = page.api.S.actionDialog;
  const options = asked.fields[0].options.map(option => option.value);
  const select = page.document.querySelector('.ops-action-dialog select');
  select.value = 'Eli.Lead';
  page.context.opsActionSubmit({ preventDefault() {}, currentTarget: page.document.querySelector('.ops-action-dialog') });
  await opened;
  assert.deepEqual(options, ['Eli.Lead', 'AlexK'], 'everyone but yourself');
  assert.equal(page.api.S.chatChannel, CHANNEL);
  const room = page.main().querySelector('.ops-chat-room');
  assert.match(room.textContent, /DIRECT MESSAGE/);
  assert.match(room.textContent, /Private between you and Synthetic Eli/);

  const form = page.main().querySelector('.ops-chat-compose');
  form.querySelector('textarea').value = 'Can you cover Saturday?';
  await page.context.opsSendChat({ preventDefault() {}, currentTarget: Object.assign(form, { reset() { form.querySelector('textarea').value = ''; } }) });
  const message = sent.find(body => body.collection === 'directMessages');
  assert.ok(message, 'saved as a direct message, not team chat');
  assert.equal(message.data.to, 'Eli.Lead');
  assert.equal(message.data.body, 'Can you cover Saturday?');
  assert.equal(sent.some(body => body.collection === 'teamMessages'), false);
});

test('direct-message conversations list by person with unread counts that add to the chat total', async () => {
  const page = await crewPage();
  page.api.S.people.chatRoster = ROSTER;
  page.api.S.people.directMessages = [
    { id: 'd1', channel: CHANNEL, participants: ['Eli.Lead', 'crew.one'], sender: 'Eli.Lead', senderName: 'Synthetic Eli', to: 'crew.one', toName: 'Synthetic Crew One', body: 'Truck is at the yard', createdAt: '2026-09-22T15:00:00.000Z', status: 'active' },
    { id: 'd2', channel: 'dm:alexk|crew.one', participants: ['crew.one', 'AlexK'], sender: 'crew.one', senderName: 'Synthetic Crew One', to: 'AlexK', toName: 'Synthetic Alex', body: 'Thanks', createdAt: '2026-09-22T14:00:00.000Z', status: 'active' },
  ];
  page.api.go('crew_chat');
  const buttons = [...page.main().querySelectorAll('.ops-chat-layout aside button')].map(button => button.textContent);
  const eli = buttons.find(text => /Synthetic Eli/.test(text)), alex = buttons.find(text => /Synthetic Alex/.test(text));
  assert.ok(eli && alex, 'one conversation per person, named for the other person');
  assert.match(eli, /Truck is at the yard/);
  assert.match(eli, /1/, 'their message is unread');
  assert.doesNotMatch(alex, /Synthetic Crew One/, 'your own message never names you as the other person');
  assert.match(page.main().textContent, /1 unread/);

  page.context.opsSelectChat(CHANNEL);
  assert.match(page.main().querySelector('.ops-chat-messages').textContent, /Truck is at the yard/);
  assert.doesNotMatch(page.main().querySelector('.ops-chat-messages').textContent, /Thanks/, 'each conversation shows only its own messages');
});
