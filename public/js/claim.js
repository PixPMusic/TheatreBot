const message = document.getElementById('claim-message');
const login = document.getElementById('claim-login');
const start = document.getElementById('claim-start');
const switchAccount = document.getElementById('claim-switch-account');
let csrf;
login.addEventListener('click', () => sessionStorage.setItem('theatre_claim', location.pathname));
async function checkLogin() {
    try {
        const response = await fetch('/api/auth/session');
        if (!response.ok) throw new Error('Unable to check Discord login. Refresh to retry.');
        const session = await response.json();
        if (!session.authenticated) { message.textContent = 'Sign in to claim this stream.'; login.hidden = false; return; }
        csrf = session.csrf;
        message.textContent = `Signed in as ${session.user.username}. Start only if you requested this stream.`;
        start.hidden = false;
        switchAccount.hidden = false;
    } catch (error) { message.textContent = error.message; }
}
start.addEventListener('click', async () => {
    start.disabled = true;
    message.textContent = 'Verifying your current voice channel and starting the stream…';
    try {
        const id = location.pathname.split('/').at(-1);
        const response = await fetch(`/api/claim/${id}`, { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to claim. Request !join again.');
        sessionStorage.removeItem('theatre_claim');
        location.replace('/');
    } catch (error) { message.textContent = error.message; start.disabled = false; }
});
checkLogin();

switchAccount.addEventListener('click', async () => {
    switchAccount.disabled = true;
    try {
        const response = await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
        if (!response.ok) throw new Error('Unable to sign out. Refresh and retry.');
        sessionStorage.setItem('theatre_claim', location.pathname);
        location.replace('/auth/login');
    } catch (error) { message.textContent = error.message; switchAccount.disabled = false; }
});
