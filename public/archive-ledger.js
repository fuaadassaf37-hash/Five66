(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Five66Archive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var CATEGORY_META = {
    tafaqud: { icon: "📋", label: "جدول تفقد", color: "#556b2f" },
    ghiyab: { icon: "🚫", label: "سجل غياب", color: "#8b1a1a" },
    khasm: { icon: "💰", label: "كتاب خصم", color: "#b45309" },
    procedure: { icon: "🗂️", label: "إجراء إداري", color: "#0f766e" },
    payroll: { icon: "💵", label: "إجراء مالي", color: "#166534" }
  };

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function formatStamp(value) {
    try { return new Date(value).toLocaleString("ar-SY", { dateStyle: "medium", timeStyle: "short" }); }
    catch (_) { return value || "—"; }
  }

  function fingerprint(value) {
    var text = JSON.stringify(value || []);
    var hash = 5381;
    for (var index = 0; index < text.length; index++) hash = (hash * 33) ^ text.charCodeAt(index);
    return (hash >>> 0).toString(36);
  }

  function createArchiveDocument(input) {
    var category = input.category || "procedure";
    var sourceId = String(input.sourceId || fingerprint(input.rows));
    var meta = CATEGORY_META[category] || CATEGORY_META.procedure;
    var now = new Date().toISOString();
    return {
      id: "archive-" + category + "-" + sourceId,
      category: category,
      title: input.title || meta.label,
      actionDate: input.actionDate || "",
      savedAt: input.savedAt || now,
      updatedAt: now,
      sourceId: sourceId,
      summary: clone(input.summary || {}),
      rows: clone(input.rows || []),
      links: clone(input.links || {}),
      schemaVersion: 1
    };
  }

  function upsertArchiveDocument(documents, input) {
    var next = Array.isArray(documents) ? documents : [];
    var document = createArchiveDocument(input);
    var index = next.findIndex(function (item) { return item && item.id === document.id; });
    if (index >= 0) {
      document.savedAt = next[index].savedAt || document.savedAt;
      next[index] = document;
    } else {
      next.unshift(document);
    }
    return { documents: next, document: document, created: index < 0 };
  }

  function listDocuments(documents, query) {
    var needle = String(query || "").trim().toLowerCase();
    return (Array.isArray(documents) ? documents.slice() : [])
      .filter(function (document) {
        if (!needle) return true;
        var haystack = [document.title, document.category, document.actionDate, document.sourceId, JSON.stringify(document.summary || {})].join(" ").toLowerCase();
        return haystack.indexOf(needle) >= 0;
      })
      .sort(function (left, right) { return String(right.savedAt || "").localeCompare(String(left.savedAt || "")); });
  }

  function getDocuments() {
    if (!Array.isArray(root.operationalArchiveDocuments)) root.operationalArchiveDocuments = [];
    return root.operationalArchiveDocuments;
  }

  function save(input) {
    var result = upsertArchiveDocument(getDocuments(), input);
    root.operationalArchiveDocuments = result.documents;
    return result.document;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character];
    });
  }

  function open(documentId) {
    var document = getDocuments().find(function (item) { return item && item.id === documentId; });
    if (!document) return;
    var modalTitle = root.document && root.document.getElementById("generic-modal-title");
    var modalBody = root.document && root.document.getElementById("generic-modal-body");
    if (!modalTitle || !modalBody || typeof root.openModal !== "function") {
      root.alert(document.title + "\n" + JSON.stringify(document, null, 2));
      return;
    }
    var meta = CATEGORY_META[document.category] || CATEGORY_META.procedure;
    modalTitle.textContent = meta.icon + " " + document.title;
    modalBody.innerHTML =
      '<div style="display:grid;gap:9px;direction:rtl;font-family:Cairo,Tajawal,sans-serif">' +
      '<div style="padding:10px;border-radius:9px;background:#f7f3ea"><b>تاريخ الإجراء:</b> ' + escapeHtml(document.actionDate || "غير محدد") + '</div>' +
      '<div style="padding:10px;border-radius:9px;background:#f7f3ea"><b>تاريخ الحفظ:</b> ' + escapeHtml(formatStamp(document.savedAt)) + '</div>' +
      '<div style="padding:10px;border-radius:9px;background:#f7f3ea"><b>عدد السجلات:</b> ' + escapeHtml((document.rows || []).length) + '</div>' +
      '<details><summary style="cursor:pointer;font-weight:800;color:#556b2f">عرض تفاصيل السجل المحفوظ</summary><pre style="white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;background:#1d2f25;color:#f7f3ea;padding:12px;border-radius:9px;direction:ltr;text-align:left">' + escapeHtml(JSON.stringify(document, null, 2)) + '</pre></details>' +
      '</div>';
    root.openModal("generic-modal");
  }

  function render() {
    if (!root.document) return;
    var container = root.document.getElementById("operational-archive-list");
    if (!container) return;
    var search = root.document.getElementById("operational-archive-search");
    var documents = listDocuments(getDocuments(), search ? search.value : "");
    if (!documents.length) {
      container.innerHTML = '<div class="archive-empty">لا توجد إجراءات مؤرشفة بعد. عند اعتماد تفقد أو غياب أو خصم سيظهر هنا تلقائياً.</div>';
      return;
    }
    container.innerHTML = documents.map(function (document) {
      var meta = CATEGORY_META[document.category] || CATEGORY_META.procedure;
      var count = (document.rows || []).length;
      return '<div class="archive-card" style="border-right:5px solid ' + meta.color + ';align-items:flex-start">' +
        '<div class="archive-card-info"><b>' + meta.icon + ' ' + escapeHtml(document.title) + '</b>' +
        '<span>التاريخ: ' + escapeHtml(document.actionDate || "غير محدد") + ' · السجلات: ' + count + '</span>' +
        '<span>حُفظ: ' + escapeHtml(formatStamp(document.savedAt)) + '</span></div>' +
        '<button class="btn btn-olive btn-sm" onclick="Five66Archive.open(\'' + escapeHtml(document.id) + '\')">📂 فتح السجل</button>' +
        '</div>';
    }).join("");
  }

  function notify(message, type) {
    if (typeof root.showToast === "function") root.showToast(message, type || "success");
  }

  function persist(document) {
    if (typeof root.saveState === "function") root.saveState(true);
    render();
    notify("🗄️ تم حفظ " + document.title + " في الأرشيف الدائم");
  }

  function archive(input) {
    var document = save(input);
    persist(document);
    return document;
  }

  function installActionHooks() {
    if (root.__five66ArchiveHooksInstalled) return;
    root.__five66ArchiveHooksInstalled = true;

    function wrap(name, after) {
      var original = root[name];
      if (typeof original !== "function") return;
      root[name] = function () {
        var before = {
          tafaqud: (root.tafaqudArchive || []).map(function (item) { return String(item.id) + ":" + String(item.savedAt) + ":" + String((item.rows || []).length); }),
          ghiyab: (root.ghiyabArchive || []).map(function (item) { return String(item.id) + ":" + String(item.savedAt) + ":" + String((item.rows || []).length); }),
          events: (root.personEvents || []).map(function (item) { return String(item.id); }),
          khasm: fingerprint(root.khasmRows || [])
        };
        var result = original.apply(this, arguments);
        try { after.call(this, before, arguments); } catch (error) { console.warn("archive hook " + name, error); }
        return result;
      };
    }

    wrap("confirmTafaqudArchive", function (before) {
      var item = (root.tafaqudArchive || []).find(function (entry) {
        return before.tafaqud.indexOf(String(entry.id) + ":" + String(entry.savedAt) + ":" + String((entry.rows || []).length)) < 0;
      });
      if (!item || !item.id) return;
      archive({
        category: "tafaqud", sourceId: item.id, title: "جدول تفقد — " + (item.shift || "بدون دوام"),
        actionDate: item.date, rows: item.rows,
        summary: { shift: item.shift || "", count: (item.rows || []).length },
        links: { sessionId: item.sessionId || "" }
      });
    });

    wrap("confirmGhiyabArchive", function (before) {
      var item = (root.ghiyabArchive || []).find(function (entry) {
        var key = String(entry.id) + ":" + String(entry.savedAt) + ":" + String((entry.rows || []).length);
        return entry && !entry.autoLinked && entry.rows && entry.rows.length && before.ghiyab.indexOf(key) < 0;
      });
      if (!item || !item.id) return;
      archive({
        category: "ghiyab", sourceId: item.id, title: "سجل غياب — " + (item.shift || "بدون دوام"),
        actionDate: item.date, rows: item.rows,
        summary: { shift: item.shift || "", count: (item.rows || []).length },
        links: { sessionId: item.sessionId || "", sourceTafaqudId: item.sourceTafaqudId || "" }
      });
    });

    wrap("logKhasmEventsToTimeline", function () {
      if (!Array.isArray(root.khasmRows) || !root.khasmRows.length) return;
      var field = root.document && root.document.getElementById("khasm-date");
      var date = field && field.value ? field.value : new Date().toISOString().slice(0, 10);
      archive({
        category: "khasm", sourceId: "book-" + date + "-" + fingerprint(root.khasmRows),
        title: "كتاب خصم — " + date, actionDate: date, rows: root.khasmRows,
        summary: { count: root.khasmRows.length, totalPercent: root.khasmRows.reduce(function (sum, row) { return sum + (Number(row.pct) || 0); }, 0) }
      });
    });

    wrap("addPersonEvent", function (before, args) {
      var personId = args[0], type = args[1], date = args[2], title = args[3], status = args[5], source = args[6];
      if (source === "auto") return;
      var event = (root.personEvents || []).find(function (entry) { return before.events.indexOf(String(entry.id)) < 0; });
      if (!event || !event.id) return;
      archive({
        category: "procedure", sourceId: event.id, title: title || "إجراء يدوي",
        actionDate: date || new Date().toISOString().slice(0, 10), rows: [event],
        summary: { personId: personId, type: type || "warning", status: status || "" }
      });
    });
  }

  return {
    CATEGORY_META: CATEGORY_META,
    createArchiveDocument: createArchiveDocument,
    upsertArchiveDocument: upsertArchiveDocument,
    listDocuments: listDocuments,
    fingerprint: fingerprint,
    save: save,
    archive: archive,
    render: render,
    open: open,
    installActionHooks: installActionHooks
  };
});
