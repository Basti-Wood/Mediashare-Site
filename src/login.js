document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const messageElement = document.getElementById('login-message');

    try {
        const response = await fetch('../conf/accounts.json');
        const data = await response.json();
        const account = data.accounts.find(acc => acc.username === username && acc.password === password);

        if (account) {
            sessionStorage.setItem('account', JSON.stringify(account));
            window.location.href = '../HTML/main.html';
            messageElement.textContent = `there seems to be a redirection issue, please contact the administrator.`;
            messageElement.style.color = 'orange';
        }
        else {
            messageElement.textContent = 'Invalid username or password.';
            messageElement.style.color = 'red';
        }
    } catch (error) {
        console.error('Error fetching accounts:', error);
        messageElement.textContent = 'An error occurred. Please try again later.';
        messageElement.style.color = 'red';
    }
});