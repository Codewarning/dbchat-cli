export const QUERY_RESULT_HTML_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{pageTitle}}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f2ea;
        --panel: rgba(255, 255, 255, 0.92);
        --panel-strong: rgba(255, 255, 255, 0.98);
        --ink: #1d2a34;
        --muted: #65727d;
        --accent: #0f766e;
        --accent-soft: rgba(15, 118, 110, 0.12);
        --line: rgba(29, 42, 52, 0.12);
        --shadow: 0 20px 50px rgba(18, 30, 41, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.14), transparent 34%),
          linear-gradient(180deg, #f6efe2 0%, #f3f7f8 48%, #eef4f2 100%);
      }

      .page {
        width: calc(100vw - 48px);
        margin: 30px auto;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .eyebrow {
        margin: 0 0 4px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--accent);
      }

      h1 {
        margin: 0;
        font-size: clamp(20px, 2.1vw, 30px);
        line-height: 1.1;
      }

      .summary {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 14px;
      }

      .meta-card {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel-strong);
      }

      .meta-card dt {
        margin: 0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: none;
        color: var(--muted);
      }

      .meta-card dd {
        margin: 0;
        font-size: 12px;
        font-weight: 700;
      }

      .note {
        margin: 0 0 14px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(15, 118, 110, 0.18);
        background: var(--accent-soft);
        color: #0f4c47;
      }

      details {
        margin: 0 0 14px;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel-strong);
        overflow: hidden;
      }

      summary {
        cursor: pointer;
        padding: 12px 14px;
        font-weight: 700;
      }

      pre {
        margin: 0;
        padding: 0 14px 14px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "Cascadia Mono", "Consolas", monospace;
        font-size: 13px;
        color: #22313d;
      }

      .filters-panel {
        margin: 0 0 14px;
      }

      .filters-body {
        padding: 0 14px 14px;
      }

      .filters-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: end;
        margin-bottom: 10px;
      }

      .filters-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 180px;
      }

      .filters-field--keyword {
        flex: 1 1 280px;
      }

      .filters-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: var(--muted);
      }

      .filters-input,
      .filters-select {
        width: 100%;
        min-height: 36px;
        padding: 8px 10px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        color: var(--ink);
        font: inherit;
      }

      .filters-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }

      .filters-button {
        min-height: 36px;
        padding: 8px 12px;
        border: 1px solid rgba(15, 118, 110, 0.22);
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        color: var(--accent);
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .filters-button:hover {
        background: rgba(15, 118, 110, 0.14);
      }

      .filters-status {
        font-size: 12px;
        color: var(--muted);
      }

      .conditions-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .condition-row {
        display: grid;
        grid-template-columns: minmax(180px, 1.2fr) minmax(120px, 0.9fr) minmax(180px, 1.4fr) auto;
        gap: 8px;
        align-items: end;
      }

      .condition-row[hidden] {
        display: none;
      }

      .filters-empty {
        font-size: 12px;
        color: var(--muted);
      }

      .table-shell {
        overflow-x: auto;
        overflow-y: auto;
        max-height: calc(100vh - 260px);
        border-radius: 20px;
        border: 1px solid var(--line);
        background: var(--panel-strong);
      }

      table {
        width: max-content;
        min-width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        font-size: 14px;
      }

      thead th {
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 12px 10px;
        text-align: left;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: none;
        white-space: nowrap;
        color: #24404a;
        background: linear-gradient(180deg, #d7efea 0%, #c7e8e0 100%);
        border-bottom: 1px solid rgba(29, 42, 52, 0.14);
      }

      tbody td {
        min-width: 120px;
        padding: 10px 10px;
        vertical-align: top;
        border-bottom: 1px solid rgba(29, 42, 52, 0.08);
      }

      .cell-content {
        --cell-max-height: 120px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        max-width: 180px;
      }

      .cell-content__inner {
        position: relative;
        width: 100%;
        max-height: var(--cell-max-height);
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        overflow: hidden;
        line-height: 1.45;
      }

      .cell-content--overflow .cell-content__inner::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 32px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.96) 100%);
        pointer-events: none;
      }

      .cell-content.is-expanded .cell-content__inner {
        max-height: none;
      }

      .cell-content.is-expanded .cell-content__inner::after {
        display: none;
      }

      .cell-toggle {
        padding: 0;
        border: 0;
        background: none;
        color: var(--accent);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }

      .cell-toggle:hover {
        text-decoration: underline;
      }

      .cell-toggle[hidden] {
        display: none;
      }

      tbody tr:nth-child(even) td {
        background: rgba(15, 118, 110, 0.03);
      }

      tbody tr:hover td {
        background: rgba(15, 118, 110, 0.08);
      }

      .empty {
        padding: 24px 10px;
        color: var(--muted);
      }

      @media (max-width: 720px) {
        .page {
          width: calc(100vw - 16px);
          margin: 8px auto;
          padding: 12px;
          border-radius: 18px;
        }

        .filters-body {
          padding: 0 12px 12px;
        }

        .condition-row {
          grid-template-columns: 1fr;
        }

        thead th,
        tbody td {
          padding: 9px 8px;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <p class="eyebrow">dbchat result viewer</p>
      <h1>{{title}}</h1>
      <p class="summary">{{summary}}</p>
      <section class="meta">
        {{metaCards}}
      </section>
      {{noteBlock}}
      <details>
        <summary>SQL</summary>
        <pre>{{sqlText}}</pre>
      </details>
      <details class="filters-panel">
        <summary>Search and filter</summary>
        <section class="filters-body">
          <div class="filters-toolbar">
            <label class="filters-field filters-field--keyword">
              <span class="filters-label">Keyword</span>
              <input id="globalFilterInput" class="filters-input" type="search" placeholder="Search across visible columns" />
            </label>
            <div class="filters-actions">
              <button id="addConditionButton" class="filters-button" type="button">Add condition</button>
              <button id="resetFiltersButton" class="filters-button" type="button">Reset</button>
            </div>
            <div id="filterStatus" class="filters-status">Showing all rows.</div>
          </div>
          <div id="conditionsList" class="conditions-list"></div>
          <p id="filtersEmptyState" class="filters-empty">No field conditions yet. Add one to filter by a specific column.</p>
        </section>
      </details>
      <section class="table-shell">
        <table>
          <thead>
            <tr>{{tableHead}}</tr>
          </thead>
          <tbody>
            {{tableBody}}
          </tbody>
        </table>
      </section>
    </main>
    <script>
      (function () {
        var table = document.querySelector('table');
        var tbody = table ? table.tBodies[0] : null;
        var rawRows = tbody ? Array.prototype.slice.call(tbody.rows) : [];
        var rows = rawRows.filter(function (row) {
          return !row.querySelector('.empty');
        });
        var headers = table && table.tHead && table.tHead.rows[0]
          ? Array.prototype.slice.call(table.tHead.rows[0].cells).map(function (cell, index) {
              var name = (cell.textContent || '').trim();
              return {
                index: index,
                name: name || ('column_' + String(index + 1))
              };
            })
          : [];
        var keywordInput = document.getElementById('globalFilterInput');
        var addConditionButton = document.getElementById('addConditionButton');
        var resetFiltersButton = document.getElementById('resetFiltersButton');
        var conditionsList = document.getElementById('conditionsList');
        var filterStatus = document.getElementById('filterStatus');
        var filtersEmptyState = document.getElementById('filtersEmptyState');
        var resizeFrame = null;

        function normalize(value) {
          return String(value == null ? '' : value).toLowerCase().trim();
        }

        function buildColumnOptionsMarkup() {
          var options = ['<option value="__any__">Any column</option>'];
          headers.forEach(function (header) {
            options.push('<option value="' + String(header.index) + '">' + header.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</option>');
          });
          return options.join('');
        }

        function updateConditionEmptyState() {
          if (!filtersEmptyState || !conditionsList) {
            return;
          }

          filtersEmptyState.hidden = conditionsList.children.length > 0;
        }

        function syncExpandableCell(cell) {
          if (!cell) {
            return;
          }

          var content = cell.querySelector('[data-cell-inner]');
          var toggle = cell.querySelector('.cell-toggle');
          if (!content || !toggle) {
            return;
          }

          if (!toggle.dataset.bound) {
            toggle.addEventListener('click', function () {
              cell.classList.toggle('is-expanded');
              var expanded = cell.classList.contains('is-expanded');
              toggle.textContent = expanded ? 'Collapse' : 'Expand';
              toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            });
            toggle.dataset.bound = 'true';
          }

          var wasExpanded = cell.classList.contains('is-expanded');
          if (wasExpanded) {
            cell.classList.remove('is-expanded');
          }

          var overflowing = content.scrollHeight > content.clientHeight + 1;
          cell.classList.toggle('cell-content--overflow', overflowing);

          if (!overflowing) {
            cell.classList.remove('is-expanded');
            toggle.hidden = true;
            toggle.textContent = 'Expand';
            toggle.setAttribute('aria-expanded', 'false');
            return;
          }

          if (wasExpanded) {
            cell.classList.add('is-expanded');
          }

          toggle.hidden = false;
          toggle.textContent = wasExpanded ? 'Collapse' : 'Expand';
          toggle.setAttribute('aria-expanded', wasExpanded ? 'true' : 'false');
        }

        function syncExpandableCells() {
          Array.prototype.slice.call(document.querySelectorAll('[data-expandable-cell]')).forEach(syncExpandableCell);
        }

        function createConditionRow() {
          if (!conditionsList) {
            return;
          }

          var row = document.createElement('div');
          row.className = 'condition-row';
          row.innerHTML =
            '<label class="filters-field">' +
              '<span class="filters-label">Column</span>' +
              '<select class="filters-select" data-role="column">' +
                buildColumnOptionsMarkup() +
              '</select>' +
            '</label>' +
            '<label class="filters-field">' +
              '<span class="filters-label">Match</span>' +
              '<select class="filters-select" data-role="operator">' +
                '<option value="contains">Contains</option>' +
                '<option value="equals">Equals</option>' +
                '<option value="starts_with">Starts with</option>' +
                '<option value="ends_with">Ends with</option>' +
                '<option value="empty">Is empty</option>' +
                '<option value="not_empty">Is not empty</option>' +
              '</select>' +
            '</label>' +
            '<label class="filters-field">' +
              '<span class="filters-label">Value</span>' +
              '<input class="filters-input" data-role="value" type="search" placeholder="Enter filter text" />' +
            '</label>' +
            '<div class="filters-actions">' +
              '<button class="filters-button" data-role="remove" type="button">Remove</button>' +
            '</div>';

          var operatorSelect = row.querySelector('[data-role="operator"]');
          var valueInput = row.querySelector('[data-role="value"]');
          var removeButton = row.querySelector('[data-role="remove"]');

          function syncValueAvailability() {
            var operator = operatorSelect ? operatorSelect.value : 'contains';
            var requiresValue = operator !== 'empty' && operator !== 'not_empty';
            if (valueInput) {
              valueInput.disabled = !requiresValue;
              valueInput.placeholder = requiresValue ? 'Enter filter text' : 'No value needed';
              if (!requiresValue) {
                valueInput.value = '';
              }
            }
          }

          row.addEventListener('input', applyFilters);
          row.addEventListener('change', function () {
            syncValueAvailability();
            applyFilters();
          });
          if (removeButton) {
            removeButton.addEventListener('click', function () {
              row.remove();
              updateConditionEmptyState();
              applyFilters();
            });
          }

          syncValueAvailability();
          conditionsList.appendChild(row);
          updateConditionEmptyState();
        }

        function getRowValues(row) {
          return Array.prototype.slice.call(row.cells).map(function (cell) {
            return cell.textContent || '';
          });
        }

        function matchesOperator(operator, cellValue, expectedValue) {
          if (operator === 'empty') {
            return cellValue.length === 0;
          }

          if (operator === 'not_empty') {
            return cellValue.length > 0;
          }

          if (!expectedValue.length) {
            return true;
          }

          if (operator === 'equals') {
            return cellValue === expectedValue;
          }

          if (operator === 'starts_with') {
            return cellValue.startsWith(expectedValue);
          }

          if (operator === 'ends_with') {
            return cellValue.endsWith(expectedValue);
          }

          return cellValue.includes(expectedValue);
        }

        function collectConditions() {
          if (!conditionsList) {
            return [];
          }

          return Array.prototype.slice.call(conditionsList.children).map(function (row) {
            var columnSelect = row.querySelector('[data-role="column"]');
            var operatorSelect = row.querySelector('[data-role="operator"]');
            var valueInput = row.querySelector('[data-role="value"]');

            return {
              column: columnSelect ? columnSelect.value : '__any__',
              operator: operatorSelect ? operatorSelect.value : 'contains',
              value: normalize(valueInput ? valueInput.value : '')
            };
          });
        }

        function applyFilters() {
          var keyword = normalize(keywordInput ? keywordInput.value : '');
          var conditions = collectConditions();

          if (!rows.length) {
            if (filterStatus) {
              filterStatus.textContent = 'No data rows available.';
            }
            return;
          }

          var visibleCount = 0;
          rows.forEach(function (row) {
            var rowValues = getRowValues(row).map(normalize);
            var keywordMatch = !keyword || rowValues.some(function (cellValue) {
              return cellValue.includes(keyword);
            });
            var conditionsMatch = conditions.every(function (condition) {
              if (condition.column === '__any__') {
                return rowValues.some(function (cellValue) {
                  return matchesOperator(condition.operator, cellValue, condition.value);
                });
              }

              var columnIndex = Number(condition.column);
              var cellValue = rowValues[columnIndex] || '';
              return matchesOperator(condition.operator, cellValue, condition.value);
            });
            var visible = keywordMatch && conditionsMatch;
            row.hidden = !visible;
            if (visible) {
              visibleCount += 1;
            }
          });

          if (filterStatus) {
            filterStatus.textContent = 'Showing ' + String(visibleCount) + ' of ' + String(rows.length) + ' rows.';
          }
        }

        if (keywordInput) {
          keywordInput.addEventListener('input', applyFilters);
        }

        if (addConditionButton) {
          addConditionButton.addEventListener('click', function () {
            createConditionRow();
            applyFilters();
          });
        }

        if (resetFiltersButton) {
          resetFiltersButton.addEventListener('click', function () {
            if (keywordInput) {
              keywordInput.value = '';
            }
            if (conditionsList) {
              conditionsList.innerHTML = '';
            }
            updateConditionEmptyState();
            applyFilters();
          });
        }

        window.addEventListener('resize', function () {
          if (resizeFrame !== null) {
            window.cancelAnimationFrame(resizeFrame);
          }

          resizeFrame = window.requestAnimationFrame(function () {
            resizeFrame = null;
            syncExpandableCells();
          });
        });

        updateConditionEmptyState();
        syncExpandableCells();
        applyFilters();
      })();
    </script>
  </body>
</html>
`;
