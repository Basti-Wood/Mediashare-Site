document.getElementById('login-form').addEventListener('submit', async function (event) {
    event.preventDefault();

    const username   = document.getElementById('username').value.trim();
    const password   = document.getElementById('password').value;
    const rememberMe = document.getElementById('remember-me').checked;
    const msgEl      = document.getElementById('login-message');
    const btn        = document.getElementById('login-btn');

    msgEl.textContent = '';
    btn.classList.add('is-loading');
    btn.disabled = true;

    try {
        const response = await fetch('/api/auth/login', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body:    JSON.stringify({ username, password, rememberMe })
        });

        const data = await response.json();

        if (response.ok) {
            window.location.href = '/HTML/main.html';
        } else {
            msgEl.textContent = data.error || 'Invalid username or password.';
            msgEl.className   = 'help is-danger';
        }
    } catch {
        msgEl.textContent = 'Could not reach the server. Please try again.';
        msgEl.className   = 'help is-danger';
    } finally {
        btn.classList.remove('is-loading');
        btn.disabled = false;
    }
});

// A valid remembered session should open the dashboard without showing the
// sign-in form again. Credentials stay out of browser storage and JavaScript cookies.
async function restoreLogin() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (response.ok) window.location.replace('/HTML/main.html');
    } catch { /* The form remains available if the server is temporarily unreachable. */ }
}

restoreLogin();
