const saveButton = document.getElementById('save') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLParagraphElement | null;

saveButton?.addEventListener('click', () => {
  if (statusEl) statusEl.textContent = 'Save flow not wired yet.';
});
