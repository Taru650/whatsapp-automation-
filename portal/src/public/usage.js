// Draws the Usage page chart from the JSON the server embedded in #usage-data.
(() => {
  const el = document.getElementById('usage-data');
  const canvas = document.getElementById('chart-usage');
  if (!el || !canvas || typeof Chart === 'undefined') return;
  const data = JSON.parse(el.textContent);
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [
        { label: 'Citizens', data: data.citizens, backgroundColor: '#0d6efd' },
        { label: 'Messages', data: data.messages, type: 'line', borderColor: '#fd7e14', backgroundColor: '#fd7e14', yAxisID: 'y1', tension: 0.3 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Citizens' } },
        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0 }, title: { display: true, text: 'Messages' } },
      },
    },
  });
})();
