const codeEditor = document.getElementById('code-editor');
const previewFrame = document.getElementById('preview-frame');
const runBtn = document.getElementById('run-btn');
const fileInput = document.getElementById('file-input');

function runHTML() {
  const code = codeEditor.value;
  const targetDoc = previewFrame.contentDocument || previewFrame.contentWindow.document;
  
  targetDoc.open();
  targetDoc.write(code);
  targetDoc.close();
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    codeEditor.value = event.target.result;
    runHTML();
  };
  reader.readAsText(file);
});

runBtn.addEventListener('click', runHTML);

window.addEventListener('DOMContentLoaded', () => {
  runHTML();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('Bypass engine operational.'))
      .catch(err => console.log('Offline configuration skipped:', err));
  }
});