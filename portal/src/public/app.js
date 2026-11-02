// Confirmation for forms marked data-confirm (inline onclick handlers are blocked by the CSP).
document.addEventListener('submit', (e) => {
  const msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});
