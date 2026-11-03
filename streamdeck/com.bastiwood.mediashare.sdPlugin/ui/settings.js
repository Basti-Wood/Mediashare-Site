'use strict';

let socket;
let context;
let action;
const field = id => document.getElementById(id);
function send(message) { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); }

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
    context = uuid;
    const info = JSON.parse(actionInfo);
    action = info.action;
    field('step').value = info.payload?.settings?.step || 2;
    field('dial-settings').hidden = action !== 'com.bastiwood.mediashare.volume';
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onopen = () => {
        send({ event: registerEvent, uuid });
        send({ event: 'getGlobalSettings', context });
        field('connect').disabled = false;
    };
    socket.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.event === 'didReceiveGlobalSettings') {
            const settings = message.payload?.settings || {};
            field('base-url').value = settings.baseUrl || 'https://media.bastiwood.com';
            field('token').value = settings.token || '';
        } else if (message.event === 'sendToPropertyInspector') {
            field('status').textContent = message.payload.message;
            field('connect').disabled = false;
        }
    };
    socket.onerror = () => { field('status').textContent = 'Restart Stream Deck and open this action again.'; };
    socket.onclose = () => { field('connect').disabled = true; };
};

field('connect').addEventListener('click', () => {
    const step = Number(String(field('step').value).replace(',', '.'));
    if (!Number.isFinite(step) || step < 0.01 || step > 10) {
        field('status').textContent = 'Choose a number from 0.01 to 10 for volume per tick.';
        return;
    }
    field('connect').disabled = true;
    field('status').textContent = 'Connecting…';
    send({ event: 'setSettings', context, payload: { step } });
    send({ event: 'sendToPlugin', context, action, payload: { command: 'connect', connection: {
        baseUrl: field('base-url').value.trim(), token: field('token').value.trim()
    } } });
});
