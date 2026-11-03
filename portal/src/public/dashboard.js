// Draws the dashboard charts from the JSON the server embedded in #chart-data.
(() => {
  const el = document.getElementById('chart-data');
  if (!el || typeof Chart === 'undefined') return;
  const data = JSON.parse(el.textContent);
  const colors = ['#dc3545', '#ffc107', '#0d6efd', '#198754', '#6c757d'];
  const status = document.getElementById('chart-status');
  if (status) {
    new Chart(status, {
      type: 'doughnut',
      data: { labels: data.status.labels, datasets: [{ data: data.status.values, backgroundColor: colors }] },
      options: { plugins: { legend: { position: 'bottom' } }, maintainAspectRatio: false },
    });
  }
  const category = document.getElementById('chart-category');
  if (category) {
    new Chart(category, {
      type: 'bar',
      data: { labels: data.category.labels, datasets: [{ label: 'Pending', data: data.category.values, backgroundColor: '#0d6efd' }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, maintainAspectRatio: false, scales: { x: { ticks: { precision: 0 } } } },
    });
  }
})();
