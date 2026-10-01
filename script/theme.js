/* Shared light/dark theme (same storage key as the Postman page). */
function switchTheme(theme) {
  const html = document.documentElement;
  const lightBtn = document.querySelector('.theme-btn[onclick*="light"]');
  const darkBtn = document.querySelector('.theme-btn[onclick*="dark"]');
  html.classList.remove('light-theme', 'dark-theme');
  html.setAttribute('data-bs-theme', theme === 'dark' ? 'dark' : 'light');
  if (theme === 'dark') {
    html.classList.add('dark-theme'); html.setAttribute('data-theme', 'dark');
    lightBtn?.classList.remove('active'); darkBtn?.classList.add('active');
  } else {
    html.classList.add('light-theme'); html.removeAttribute('data-theme');
    darkBtn?.classList.remove('active'); lightBtn?.classList.add('active');
  }
  try { localStorage.setItem('theme', theme); } catch (e) {}
}
document.addEventListener('DOMContentLoaded', () => {
  let saved = null; try { saved = localStorage.getItem('theme'); } catch (e) {}
  switchTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
});
