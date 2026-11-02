'use strict';

(() => {
    const field = id => document.getElementById(id);
    let channel = null;
    let revision = 0;
    let busy = false;
    let connectionInfo = null;

    function show(connection) {
        connectionInfo = connection;
        field('streamdeck-create').textContent = connection ? 'Replace connection token' : 'Create connection token';
        field('streamdeck-create').disabled = busy;
        field('streamdeck-revoke').disabled = busy || !connection;
    }
    function clearToken() {
        field('streamdeck-token').value = '';
        field('streamdeck-token-wrap').hidden = true;
        field('streamdeck-copy').disabled = true;
    }
    async function request(method) {
        const res = await fetch(`/api/streamdeck/${encodeURIComponent(channel)}/connection`, { method });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not update the Stream Deck connection.');
        return data;
    }
    async function setChannel(next) {
        channel = next;
        const current = ++revision;
        busy = false;
        clearToken();
        show(null);
        field('streamdeck-create').disabled = true;
        field('streamdeck-site-url').value = window.location.origin;
        field('streamdeck-status').textContent = 'Loading connection…';
        try {
            const data = await request('GET');
            if (current !== revision) return;
            show(data.connection);
            field('streamdeck-status').textContent = data.connection
                ? `A token exists for ${channel}. Replace it if you need a new copy.`
                : `Create a token to control ${channel} from Stream Deck.`;
        } catch (err) {
            if (current !== revision) return;
            show(null);
            field('streamdeck-status').textContent = err.message;
        }
    }
    field('streamdeck-create').addEventListener('click', async () => {
        if (!channel || busy) return;
        const current = revision;
        busy = true;
        field('streamdeck-create').disabled = true;
        field('streamdeck-revoke').disabled = true;
        try {
            const data = await request('POST');
            if (current !== revision) return;
            clearToken();
            field('streamdeck-token').value = data.token;
            field('streamdeck-token-wrap').hidden = false;
            field('streamdeck-copy').disabled = false;
            field('streamdeck-status').textContent = `Token ready for ${channel}. Copy it into the Stream Deck action settings.`;
            busy = false;
            show(data.connection);
        } catch (err) {
            if (current === revision) { busy = false; show(connectionInfo); field('streamdeck-status').textContent = err.message; }
        }
    });
    field('streamdeck-revoke').addEventListener('click', async () => {
        if (!channel || busy) return;
        const current = revision;
        busy = true;
        field('streamdeck-create').disabled = true;
        field('streamdeck-revoke').disabled = true;
        try {
            await request('DELETE');
            if (current !== revision) return;
            clearToken();
            busy = false;
            show(null);
            field('streamdeck-status').textContent = 'Stream Deck disconnected.';
        } catch (err) {
            if (current === revision) { busy = false; show(connectionInfo); field('streamdeck-status').textContent = err.message; }
        }
    });
    field('streamdeck-copy').addEventListener('click', async () => {
        const token = field('streamdeck-token');
        if (!token.value) return;
        try {
            await navigator.clipboard.writeText(token.value);
            field('streamdeck-status').textContent = 'Token copied. Paste it into the Stream Deck action settings.';
        } catch {
            token.focus();
            token.select();
            field('streamdeck-status').textContent = document.execCommand?.('copy')
                ? 'Token copied.' : 'Token selected. Press Ctrl+C (⌘C on Mac) to copy it.';
        }
    });
    window.mediashareStreamDeck = { setChannel };
})();
