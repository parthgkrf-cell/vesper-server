/* -------------------------------------------------------------
 * VESPER MAIL SCHEDULER — CORE ENGINE & UI LOGIC
 * ------------------------------------------------------------- */

// State Object
let state = {
  recipients: [],
  stagedImportFiles: [],
  sentRegistry: [], // Array of normalized emails that have already been sent
  queueFilters: {
    template: "all",
    file: "all",
    account: "all",
    status: "all",
    search: ""
  },
  template: {
    subject: "",
    cc: "",
    bcc: "",
    body: "",
    senderAccountId: "",
    action: "send"
  },
  settings: {
    method: "localserver_send",
    localUrl: window.location.origin.startsWith("http") ? window.location.origin + "/send" : "http://localhost:3000/send",
    localAction: "send",
    sendDelay: 60,
    senderAccounts: [] // array of { id, label, user, pass, host, port, secure, isDefault }
  },
  schedulerActive: false,
  previewLayout: "single",
  logs: [],
  headers: {} // Map of column letters to header labels
};

// Global Timer Reference
let schedulerInterval = null;

// Initialize Application on Page Load
document.addEventListener("DOMContentLoaded", async () => {
  // Enforce strict light theme
  document.documentElement.setAttribute("data-theme", "light");
  
  loadStateFromCache();
  
  // Try loading from server config (which acts as a unified file config)
  try {
    await loadConfigFromServer();
  } catch (e) {
    console.error("Could not sync with server config:", e);
  }
  
  initializeUI();
  setupEventListeners();
  startClock();
  
  // If scheduler was active on server, reflect in UI and start polling
  if (state.settings && state.settings.schedulerActive) {
    state.schedulerActive = true;
    updateSchedulerUIState();
    startPollingState();
  }
  
  lucide.createIcons();
  
  addLog("System initialized. Welcome to Vesper Mail Scheduler.", "system");
});

// Load Configuration from server
async function loadConfigFromServer() {
  try {
    if (window.location.protocol.startsWith("http")) {
      const response = await fetch("/api/config");
      if (response.ok) {
        const config = await response.json();
        if (config.settings) {
          state.settings = { ...state.settings, ...config.settings };
          // Ensure URL is updated to current origin if served from server
          state.settings.localUrl = window.location.origin + "/send";
        }
        if (config.templates) {
          state.templates = config.templates;
          state.activeTemplateId = config.activeTemplateId || state.templates[0].id;
        } else if (config.template) {
          state.template = { ...state.template, ...config.template };
        }
        if (config.sentRegistry && Array.isArray(config.sentRegistry)) {
          state.sentRegistry = config.sentRegistry;
          localStorage.setItem("vesper_sent_registry", JSON.stringify(state.sentRegistry));
        }
        if (config.recipients) {
          // Re-hydrate Date objects
          state.recipients = config.recipients.map(r => ({
            ...r,
            parsedTime: r.parsedTime ? new Date(r.parsedTime) : null
          }));
        }
        syncSentRegistryWithRecipients();
        if (config.headers) {
          state.headers = config.headers;
          localStorage.setItem("vesper_headers", JSON.stringify(state.headers));
        }
        // Force upgrade/migration for settings method
        if (state.settings.method !== "localserver_send" && state.settings.method !== "localserver_draft") {
          state.settings.method = state.settings.localAction === "draft" ? "localserver_draft" : "localserver_send";
        }
        if (!state.settings.sendDelay) state.settings.sendDelay = 60;
        // Cache to localStorage
        localStorage.setItem("vesper_settings", JSON.stringify(state.settings));
        if (state.templates) {
          saveTemplateToCache();
          localStorage.setItem("vesper_active_template_id", state.activeTemplateId);
        }
        localStorage.setItem("vesper_template", JSON.stringify(state.template));
        localStorage.setItem("vesper_recipients", JSON.stringify(state.recipients));
      }
    }
  } catch (e) {
    console.warn("Could not load config from server (maybe running as standalone file://):", e);
  }
}

// Save Configuration to server
async function saveConfigToServer() {
  try {
    let endpoint = "/api/config";
    if (!window.location.protocol.startsWith("http")) {
      const localBase = state.settings.localUrl ? state.settings.localUrl.replace(/\/send$/, "") : "http://localhost:3000";
      endpoint = `${localBase}/api/config`;
    }
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        settings: state.settings,
        template: state.template,
        templates: state.templates,
        activeTemplateId: state.activeTemplateId,
        recipients: state.recipients,
        sentRegistry: state.sentRegistry || [],
        headers: state.headers
      })
    });
  } catch (e) {
    console.error("Error saving config to server:", e);
  }
}

// Load Cached Settings & Templates
function loadStateFromCache() {
  const cachedSettings = localStorage.getItem("vesper_settings");
  if (cachedSettings) {
    try {
      state.settings = { ...state.settings, ...JSON.parse(cachedSettings) };
      // Force migrate all legacy methods to localserver send/draft
      if (state.settings.method !== "localserver_send" && state.settings.method !== "localserver_draft") {
        state.settings.method = state.settings.localAction === "draft" ? "localserver_draft" : "localserver_send";
      }

      // Auto-heal / sanitize all loaded sender accounts
      if (state.settings.senderAccounts && Array.isArray(state.settings.senderAccounts)) {
        state.settings.senderAccounts.forEach(acc => {
          if (acc.pass) {
            acc.pass = sanitizePassword(acc.pass, acc.host, acc.user);
          }
          if (acc.host === "smtp.gr.foundation" || (acc.user && acc.user.endsWith("@gr.foundation"))) {
            acc.host = "smtp.gmail.com";
          } else if (acc.host) {
            acc.host = sanitizeSmtpHost(acc.host);
          }
          if (!acc.host && acc.user) {
            acc.host = autoDetectSmtpSettings(acc.user).host;
          }
          if (acc.port === "587" && acc.secure === "ssl") {
            acc.secure = "tls";
          }
          if (acc.port === "465" && acc.secure === "tls") {
            acc.secure = "ssl";
          }
        });
      }
    } catch (e) {
      console.error("Error loading cached settings:", e);
    }
  }

  const cachedTemplates = localStorage.getItem("vesper_templates");
  const cachedActiveId = localStorage.getItem("vesper_active_template_id");
  if (cachedTemplates) {
    try {
      state.templates = JSON.parse(cachedTemplates);
      state.activeTemplateId = cachedActiveId || state.templates[0].id;
    } catch (e) {
      console.error("Error loading cached templates:", e);
    }
  }

  // Migrate if upgrading from older single template version
  if (!state.templates || state.templates.length === 0) {
    const cachedTemplate = localStorage.getItem("vesper_template");
    let oldTemplate = null;
    if (cachedTemplate) {
      try { oldTemplate = JSON.parse(cachedTemplate); } catch (e) {}
    }
    state.templates = [
      {
        id: "template-default",
        name: "Default Template",
        subject: oldTemplate?.subject || "",
        cc: oldTemplate?.cc || "",
        bcc: oldTemplate?.bcc || "",
        body: oldTemplate?.body || "",
        senderAccountId: oldTemplate?.senderAccountId || "",
        action: oldTemplate?.action || "send"
      }
    ];
    state.activeTemplateId = "template-default";
  }

  // Set the active template reference
  state.template = state.templates.find(t => t.id === state.activeTemplateId) || state.templates[0];

  const isServerMode = window.location.protocol.startsWith("http");
  if (!isServerMode) {
    const cachedRecipients = localStorage.getItem("vesper_recipients");
    if (cachedRecipients) {
      try {
        const parsed = JSON.parse(cachedRecipients);
        // Re-hydrate Date objects
        state.recipients = parsed.map(r => ({
          ...r,
          parsedTime: r.parsedTime ? new Date(r.parsedTime) : null
        }));
      } catch (e) {
        console.error("Error loading cached recipients:", e);
      }
    }
  }

  const cachedSentRegistry = localStorage.getItem("vesper_sent_registry");
  if (cachedSentRegistry) {
    try {
      state.sentRegistry = JSON.parse(cachedSentRegistry);
    } catch (e) {
      console.error("Error loading cached sent registry:", e);
    }
  }
  if (!state.sentRegistry) {
    state.sentRegistry = [];
  }

  const cachedHeaders = localStorage.getItem("vesper_headers");
  if (cachedHeaders) {
    try {
      state.headers = JSON.parse(cachedHeaders);
    } catch (e) {
      console.error("Error loading cached headers:", e);
    }
  }
}

// Save Settings and Template to Cache
function saveSettingsToCache() {
  localStorage.setItem("vesper_settings", JSON.stringify(state.settings));
  saveConfigToServer();
}

function getConfiguredAction() {
  if (state.settings.method === "localserver_draft" || state.settings.localAction === "draft") {
    return "draft";
  }
  return "send";
}

function saveTemplateToCache() {
  if (state.templates && state.template && state.activeTemplateId) {
    const idx = state.templates.findIndex(t => t.id === state.activeTemplateId);
    if (idx >= 0 && state.templates[idx] !== state.template) {
      state.templates[idx] = state.template;
    }
  }
  localStorage.setItem("vesper_template", JSON.stringify(state.template));
  localStorage.setItem("vesper_templates", JSON.stringify(state.templates || []));
  localStorage.setItem("vesper_active_template_id", state.activeTemplateId || "");
  saveConfigToServer();
}

function saveRecipientsToCache() {
  localStorage.setItem("vesper_recipients", JSON.stringify(state.recipients));
  localStorage.setItem("vesper_headers", JSON.stringify(state.headers));
  saveConfigToServer();
}

// Start Clock in Header
function startClock() {
  const clockElement = document.getElementById("current-time-text");
  const updateClock = () => {
    const now = new Date();
    clockElement.textContent = now.toLocaleString();
  };
  updateClock();
  setInterval(updateClock, 1000);
}

// Initialize Form fields with state values
function initializeUI() {
  // Populate settings
  document.getElementById("local-server-url").value = state.settings.localUrl;
  document.getElementById("local-server-action").value = state.settings.localAction || "send";

  // Render sender accounts table
  renderSenderAccountsTable();

  // Set method radio check
  const radio = document.querySelector(`input[name="sending-method"][value="${state.settings.method}"]`);
  if (radio) {
    radio.checked = true;
    // Sync active style for cards
    document.querySelectorAll(".method-card").forEach(c => c.classList.remove("active"));
    radio.closest(".method-card").classList.add("active");
    updateMethodFieldsVisibility(state.settings.method);
  }

  // Populate templates
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  document.getElementById("email-subject-template").value = state.template.subject || "";
  document.getElementById("email-cc-template").value = state.template.cc || "";
  document.getElementById("email-bcc-template").value = state.template.bcc || "";
  let bodyHtml = state.template.body || "";
  if (bodyHtml && !bodyHtml.includes("<") && !bodyHtml.includes(">")) {
    bodyHtml = bodyHtml.replace(/\n/g, "<br>");
  }
  const bodyEditor = document.getElementById("email-body-editor");
  if (bodyEditor) {
    bodyEditor.innerHTML = bodyHtml;
  }
  document.getElementById("email-action-template").value = getConfiguredAction();

  // Sync Word (.docx) source banner if active template was imported from Word file
  const docxBanner = document.getElementById("docx-loaded-banner");
  const docxBannerFilename = document.getElementById("docx-banner-filename");
  if (docxBanner && docxBannerFilename) {
    if (state.template.docxSource) {
      docxBannerFilename.textContent = `Template imported from: ${state.template.docxSource}`;
      docxBanner.classList.remove("hidden");
    } else {
      docxBanner.classList.add("hidden");
    }
  }

  // Populate sender accounts dropdown in compose template tab
  populateSenderDropdowns();
  updateComposeReadOnlyConfig();

  // Render lists if cache contains recipients
  if (state.recipients.length > 0) {
    document.getElementById("parsed-data-section").classList.remove("hidden");
    renderExcelTable();
    updateSummaryStats();
    populateRecipientDropdown();
    renderQueueTable();

    // Restore dynamic column headers and merge tags menu from cache
    if (state.headers && Object.keys(state.headers).length > 0) {
      const colLetters = Object.keys(state.headers);
      updateMergeTagsMenu(colLetters, state.headers);
      
      const getColByHeader = (alts) => {
        return colLetters.find(l => {
          const val = String(state.headers[l]).trim().toLowerCase();
          return alts.some(alt => val === alt.toLowerCase() || val.includes(alt.toLowerCase()));
        });
      };
      
      const nameCol = getColByHeader(["Name", "First Name", "Recipient Name", "Full Name", "Contact Name"]);
      const emailCol = getColByHeader(["Email", "Email Address", "Mail", "EmailID"]);
      const affCol = getColByHeader(["Affiliation", "Company", "Organization", "Aff"]);
      const dateCol = getColByHeader(["Date", "Mail Date", "Scheduled Date"]);
      const techCol = getColByHeader(["Session", "session", "Technical Schedual Name", "Technical Schedule Name", "Tech Schedule", "Tech Schedual", "Schedule Name", "tsname"]);
      const timeCol = getColByHeader(["Time", "Event Time", "Time Tag"]);
      
      updateTableHeadersWithLetters({
        name: nameCol,
        email: emailCol,
        aff: affCol,
        date: dateCol,
        session: techCol,
        time: timeCol
      });
    }
  }
}

let savedSelectionRange = null;

function saveSelection() {
  const sel = window.getSelection();
  if (sel.getRangeAt && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const editor = document.getElementById("email-body-editor");
    if (editor && editor.contains(range.commonAncestorContainer)) {
      savedSelectionRange = range.cloneRange();
    }
  }
}

function restoreSelection() {
  if (savedSelectionRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedSelectionRange);
  }
}

// Setup all DOM event listeners
function setupEventListeners() {


  // Tab Navigation
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const tabId = item.getAttribute("data-tab");
      switchTab(tabId);
    });
  });

  // Settings Radio Selectors
  document.querySelectorAll('input[name="sending-method"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.settings.method = e.target.value;
      
      // Update local action based on specific local server method
      if (state.settings.method === "localserver_send") {
        state.settings.localAction = "send";
        const selectEl = document.getElementById("local-server-action");
        if (selectEl) selectEl.value = "send";
      } else if (state.settings.method === "localserver_draft") {
        state.settings.localAction = "draft";
        const selectEl = document.getElementById("local-server-action");
        if (selectEl) selectEl.value = "draft";
      }
      
      saveSettingsToCache();
      updateMethodFieldsVisibility(e.target.value);
      updateComposeReadOnlyConfig();
      if (document.getElementById("tab-queue") && document.getElementById("tab-queue").classList.contains("active")) {
        renderQueueTable();
      }
      
      // Update styling class on parent method cards
      document.querySelectorAll(".method-card").forEach(c => c.classList.remove("active"));
      e.target.closest(".method-card").classList.add("active");
      
      addLog(`Sending mode changed to: ${e.target.value}`, "system");
      showToast(`Mode set to ${e.target.value}`, "info");
    });
  });

  // Settings inputs save on change
  const settingsInputs = [
    { id: "local-server-url", key: "localUrl" },
    { id: "local-server-action", key: "localAction" }
  ];

  settingsInputs.forEach(inputInfo => {
    const el = document.getElementById(inputInfo.id);
    if (el) {
      el.addEventListener("input", (e) => {
        state.settings[inputInfo.key] = e.target.value;
        
        // If localAction changes, sync sending-method radio button
        if (inputInfo.key === "localAction") {
          const targetMethod = e.target.value === "draft" ? "localserver_draft" : "localserver_send";
          state.settings.method = targetMethod;
          const radio = document.querySelector(`input[name="sending-method"][value="${targetMethod}"]`);
          if (radio) {
            radio.checked = true;
            document.querySelectorAll(".method-card").forEach(c => c.classList.remove("active"));
            radio.closest(".method-card").classList.add("active");
          }
        }
        
        saveSettingsToCache();
        updateComposeReadOnlyConfig();
        if (document.getElementById("tab-queue") && document.getElementById("tab-queue").classList.contains("active")) {
          renderQueueTable();
        }
      });
    }
  });

  // Add Sender Account Event Listener
  const btnAddAcc = document.getElementById("btn-add-sender-account");
  if (btnAddAcc) {
    btnAddAcc.addEventListener("click", () => {
      const label = document.getElementById("acc-label").value.trim();
      const user = document.getElementById("acc-user").value.trim().replace(/\xa0/g, "");
      const rawPass = document.getElementById("acc-pass").value;
      const rawHost = document.getElementById("acc-host").value.trim();
      const port = document.getElementById("acc-port").value.trim();
      const secure = document.getElementById("acc-secure").value;

      if (!label || !user || !rawPass || !rawHost || !port) {
        showToast("Please fill in all SMTP account fields.", "warning");
        return;
      }

      const host = sanitizeSmtpHost(rawHost) || autoDetectSmtpSettings(user).host;
      const pass = sanitizePassword(rawPass, host, user);

      // Check if email account already exists
      if (!state.settings.senderAccounts) {
        state.settings.senderAccounts = [];
      }
      
      const exists = state.settings.senderAccounts.some(acc => acc.user.toLowerCase() === user.toLowerCase());
      if (exists) {
        showToast("An account with this email already exists.", "warning");
        return;
      }

      const isDefault = state.settings.senderAccounts.length === 0;

      const newAcc = {
        id: `acc-${Date.now()}`,
        label,
        user,
        pass,
        host,
        port,
        secure,
        isDefault
      };

      state.settings.senderAccounts.push(newAcc);
      saveSettingsToCache();
      
      // Clear inputs
      document.getElementById("acc-label").value = "";
      document.getElementById("acc-user").value = "";
      document.getElementById("acc-pass").value = "";
      document.getElementById("acc-host").value = "smtp.gmail.com";
      document.getElementById("acc-port").value = "465";
      document.getElementById("acc-secure").value = "ssl";

      renderSenderAccountsTable();
      populateSenderDropdowns();
      relinkRecipientsSenderAccounts();
      renderQueueTable(); // updates dropdowns in queue
      showToast("Sender account added successfully!", "success");
      addLog(`Added sender account: ${label} (${user})`, "success");
    });
  }

  // Auto-sync port & encryption dropdown in Configuration panel
  const accPortInput = document.getElementById("acc-port");
  const accSecureSelect = document.getElementById("acc-secure");
  const accHostInput = document.getElementById("acc-host");

  if (accPortInput && accSecureSelect) {
    accPortInput.addEventListener("input", () => {
      const portVal = accPortInput.value.trim();
      if (portVal === "587") {
        accSecureSelect.value = "tls";
      } else if (portVal === "465") {
        accSecureSelect.value = "ssl";
      } else if (portVal === "25" || portVal === "2525") {
        accSecureSelect.value = "none";
      }
    });

    accSecureSelect.addEventListener("change", () => {
      const secVal = accSecureSelect.value;
      if (secVal === "tls" && accPortInput.value !== "587") {
        accPortInput.value = "587";
      } else if (secVal === "ssl" && accPortInput.value !== "465") {
        accPortInput.value = "465";
      } else if (secVal === "none" && accPortInput.value !== "25") {
        accPortInput.value = "25";
      }
    });
  }

  // Quick Presets Bar click handlers
  document.querySelectorAll(".btn-preset-smtp").forEach(btn => {
    btn.addEventListener("click", () => {
      const h = btn.getAttribute("data-host");
      const p = btn.getAttribute("data-port");
      const s = btn.getAttribute("data-secure");
      if (accHostInput) accHostInput.value = h;
      if (accPortInput) accPortInput.value = p;
      if (accSecureSelect) accSecureSelect.value = s;
      showToast(`Applied ${btn.textContent.trim()} preset`, "info");
    });
  });

  // Template inputs save and update live preview
  const subjectInput = document.getElementById("email-subject-template");
  const ccInput = document.getElementById("email-cc-template");
  const bccInput = document.getElementById("email-bcc-template");
  const bodyEditor = document.getElementById("email-body-editor");
  const actionSelect = document.getElementById("email-action-template");
  const senderSelect = document.getElementById("email-sender-template");

  if (bodyEditor) {
    bodyEditor.addEventListener("keyup", saveSelection);
    bodyEditor.addEventListener("mouseup", saveSelection);
    bodyEditor.addEventListener("focusout", saveSelection);
  }

  subjectInput.addEventListener("input", () => {
    state.template.subject = subjectInput.value;
    saveTemplateToCache();
    updateLivePreview();
  });

  if (ccInput) {
    ccInput.addEventListener("input", () => {
      state.template.cc = ccInput.value;
      saveTemplateToCache();
      updateLivePreview();
    });
  }

  if (bccInput) {
    bccInput.addEventListener("input", () => {
      state.template.bcc = bccInput.value;
      saveTemplateToCache();
      updateLivePreview();
    });
  }

  // CC and BCC toggles in Gmail style
  const toggleCc = document.getElementById("toggle-cc-field");
  const toggleBcc = document.getElementById("toggle-bcc-field");
  const rowCc = document.getElementById("cc-field-row");
  const rowBcc = document.getElementById("bcc-field-row");
  
  if (toggleCc && rowCc) {
    toggleCc.addEventListener("click", () => {
      rowCc.classList.toggle("hidden");
    });
  }
  if (toggleBcc && rowBcc) {
    toggleBcc.addEventListener("click", () => {
      rowBcc.classList.toggle("hidden");
    });
  }

  // Persist visibility of CC/BCC if they have values on load
  if (state.template.cc && rowCc) rowCc.classList.remove("hidden");
  if (state.template.bcc && rowBcc) rowBcc.classList.remove("hidden");

  // Gmail Save Status Debounce
  let saveTimeout = null;
  if (bodyEditor) {
    bodyEditor.addEventListener("input", () => {
      const statusEl = document.getElementById("gmail-save-status");
      if (statusEl) statusEl.textContent = "Saving...";
      
      state.template.body = bodyEditor.innerHTML;
      saveTemplateToCache();
      updateLivePreview();
      
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        if (statusEl) statusEl.textContent = "Draft saved";
      }, 800);
    });
  }

  if (actionSelect) {
    actionSelect.value = getConfiguredAction();
    actionSelect.addEventListener("change", () => {
      actionSelect.value = getConfiguredAction();
      showToast("Send or Draft is set on the Configuration page only.", "info");
    });
  }

  if (senderSelect) {
    senderSelect.addEventListener("change", (e) => {
      state.template.senderAccountId = e.target.value;
      saveTemplateToCache();
      updateLivePreview();
      const acc = state.settings.senderAccounts.find(a => a.id === e.target.value);
      if (acc) {
        showToast(`Default sender set to ${acc.label}`, "info");
      }
    });
  }

  // Gmail toolbar formatting options toggle
  const btnToggleFormat = document.getElementById("btn-toggle-formatting");
  const formattingToolbar = document.getElementById("gmail-formatting-toolbar");
  if (btnToggleFormat && formattingToolbar) {
    btnToggleFormat.addEventListener("click", () => {
      btnToggleFormat.classList.toggle("active");
      formattingToolbar.classList.toggle("hidden");
    });
  }

  // Gmail insert link button
  const btnInsertLink = document.getElementById("btn-insert-link");
  if (btnInsertLink) {
    btnInsertLink.addEventListener("click", () => {
      const url = prompt("Enter URL:", "https://");
      if (url) {
        restoreSelection();
        document.execCommand("createLink", false, url);
        bodyEditor.focus();
        state.template.body = bodyEditor.innerHTML;
        saveTemplateToCache();
        updateLivePreview();
      }
    });
  }

  // Gmail text color picker toggles
  const btnTextColor = document.getElementById("btn-text-color");
  const textColorDropdown = document.getElementById("text-color-dropdown");
  if (btnTextColor && textColorDropdown) {
    btnTextColor.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Prevents selection loss when clicking dropdown toggle
    });
    btnTextColor.addEventListener("click", (e) => {
      e.stopPropagation();
      textColorDropdown.classList.toggle("hidden");
    });
    document.addEventListener("click", () => {
      textColorDropdown.classList.add("hidden");
    });
  }

  // Helper for parsing CSS RGB / Hex / Color strings
  window.parseCssColor = function(input) {
    if (!input) return null;
    let str = String(input).trim();
    
    // RGB(7,55,99) or rgb(7, 55, 99) or rgba(...)
    const rgbMatch = str.match(/^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d\.]+)?\s*\)$/i);
    if (rgbMatch) {
      const r = Math.min(255, parseInt(rgbMatch[1], 10));
      const g = Math.min(255, parseInt(rgbMatch[2], 10));
      const b = Math.min(255, parseInt(rgbMatch[3], 10));
      const hex = "#" + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      return { css: `rgb(${r}, ${g}, ${b})`, hex: hex, r, g, b, raw: `RGB(${r},${g},${b})` };
    }
    
    // Comma separated 7, 55, 99 or 7,55,99
    const csvMatch = str.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
    if (csvMatch) {
      const r = Math.min(255, parseInt(csvMatch[1], 10));
      const g = Math.min(255, parseInt(csvMatch[2], 10));
      const b = Math.min(255, parseInt(csvMatch[3], 10));
      const hex = "#" + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      return { css: `rgb(${r}, ${g}, ${b})`, hex: hex, r, g, b, raw: `RGB(${r},${g},${b})` };
    }

    // Hex #073763 or 073763
    if (/^#?[0-9a-fA-F]{6}$/.test(str)) {
      const hex = str.startsWith('#') ? str : '#' + str;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return { css: `rgb(${r}, ${g}, ${b})`, hex: hex, r, g, b, raw: `RGB(${r},${g},${b})` };
    }

    // Standard named colors
    if (/^[a-zA-Z]+$/.test(str)) {
      return { css: str, hex: str, raw: str };
    }
    
    return null;
  };

  function applyColorToEditorSelection(colorInput, targetType) {
    const parsed = parseCssColor(colorInput);
    if (!parsed) {
      showToast("Invalid RGB/Color format. Example: RGB(7,55,99) or #073763", "warning");
      return;
    }

    let cmdType = (targetType === "backcolor" || targetType === "backColor") ? "hiliteColor" : "foreColor";

    restoreSelection();
    document.execCommand(cmdType, false, parsed.css);

    if (bodyEditor) {
      bodyEditor.focus();
      state.template.body = bodyEditor.innerHTML;
      saveTemplateToCache();
      updateLivePreview();
    }

    // Sync UI fields
    const customRgbInput = document.getElementById("custom-rgb-input");
    const previewIndicator = document.getElementById("rgb-preview-indicator");
    const colorPicker = document.getElementById("custom-color-input");

    if (customRgbInput) customRgbInput.value = parsed.raw || parsed.css;
    if (previewIndicator) previewIndicator.style.backgroundColor = parsed.css;
    if (colorPicker && parsed.hex.startsWith("#")) colorPicker.value = parsed.hex;
  }

  // Color selection in picker swatches
  document.querySelectorAll(".color-box").forEach(box => {
    box.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Prevents selection loss when clicking color boxes
    });
    box.addEventListener("click", (e) => {
      e.preventDefault();
      let type = box.getAttribute("data-type");
      const color = box.getAttribute("data-color");
      applyColorToEditorSelection(color, type);
    });
  });

  // RGB Text Input & Swatch Color Listeners
  const customRgbInput = document.getElementById("custom-rgb-input");
  const customColorInput = document.getElementById("custom-color-input");
  const customColorType = document.getElementById("custom-color-type");
  const btnApplyRgb = document.getElementById("btn-apply-rgb-color");
  const previewIndicator = document.getElementById("rgb-preview-indicator");

  if (customRgbInput && customColorInput && customColorType) {
    [customRgbInput, customColorInput, customColorType, btnApplyRgb, previewIndicator].forEach(el => {
      if (el) {
        el.addEventListener("mousedown", (e) => e.stopPropagation());
      }
    });

    customRgbInput.addEventListener("input", (e) => {
      const parsed = parseCssColor(e.target.value);
      if (parsed) {
        if (previewIndicator) previewIndicator.style.backgroundColor = parsed.css;
        if (parsed.hex.startsWith("#")) customColorInput.value = parsed.hex;
      }
    });

    customRgbInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyColorToEditorSelection(customRgbInput.value, customColorType.value);
      }
    });

    customColorInput.addEventListener("input", (e) => {
      const parsed = parseCssColor(e.target.value);
      if (parsed) {
        customRgbInput.value = parsed.raw || parsed.css;
        if (previewIndicator) previewIndicator.style.backgroundColor = parsed.css;
      }
    });

    customColorInput.addEventListener("change", (e) => {
      applyColorToEditorSelection(e.target.value, customColorType.value);
    });

    if (btnApplyRgb) {
      btnApplyRgb.addEventListener("click", (e) => {
        e.preventDefault();
        applyColorToEditorSelection(customRgbInput.value, customColorType.value);
      });
    }

    document.querySelectorAll(".rgb-quick-tag").forEach(tag => {
      tag.addEventListener("mousedown", (e) => e.stopPropagation());
      tag.addEventListener("click", (e) => {
        e.preventDefault();
        const rgbVal = tag.getAttribute("data-rgb");
        if (customRgbInput) customRgbInput.value = rgbVal;
        applyColorToEditorSelection(rgbVal, customColorType.value);
      });
    });
  }

  // Formatting commands in toolbar
  document.querySelectorAll(".toolbar-btn").forEach(btn => {
    const command = btn.getAttribute("data-command");
    if (command) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        restoreSelection();
        document.execCommand(command, false, null);
        btn.classList.toggle("active", document.queryCommandState(command));
        bodyEditor.focus();
        state.template.body = bodyEditor.innerHTML;
        saveTemplateToCache();
        updateLivePreview();
      });
    }
  });

  // Font family dropdown
  const fontSelect = document.getElementById("editor-font-family");
  if (fontSelect) {
    fontSelect.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Prevents selection loss when clicking select menu
    });
    fontSelect.addEventListener("change", (e) => {
      restoreSelection();
      document.execCommand("fontName", false, e.target.value);
      bodyEditor.focus();
      state.template.body = bodyEditor.innerHTML;
      saveTemplateToCache();
      updateLivePreview();
    });
  }

  // Font size dropdown
  const sizeSelect = document.getElementById("editor-font-size");
  if (sizeSelect) {
    sizeSelect.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Prevents selection loss when clicking select menu
    });
    sizeSelect.addEventListener("change", (e) => {
      restoreSelection();
      document.execCommand("fontSize", false, e.target.value);
      bodyEditor.focus();
      state.template.body = bodyEditor.innerHTML;
      saveTemplateToCache();
      updateLivePreview();
    });
  }

  // Gmail Merge tags dropdown toggle
  const btnMergeTags = document.getElementById("btn-show-merge-tags");
  const mergeTagsMenu = document.getElementById("gmail-merge-tags-menu");
  if (btnMergeTags && mergeTagsMenu) {
    btnMergeTags.addEventListener("click", (e) => {
      e.stopPropagation();
      mergeTagsMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => {
      mergeTagsMenu.classList.add("hidden");
    });

    document.querySelectorAll(".merge-tag-item").forEach(item => {
      item.addEventListener("click", () => {
        const tag = item.getAttribute("data-tag");
        bodyEditor.focus();
        insertTextAtCursor(tag);
        state.template.body = bodyEditor.innerHTML;
        saveTemplateToCache();
        updateLivePreview();
      });
    });
  }

  // Discard button in Gmail footer
  const btnDiscard = document.getElementById("btn-discard-gmail-body");
  if (btnDiscard) {
    btnDiscard.addEventListener("click", () => {
      if (confirm("Are you sure you want to clear the template message body?")) {
        if (bodyEditor) bodyEditor.innerHTML = "";
        state.template.body = "";
        saveTemplateToCache();
        updateLivePreview();
        showToast("Composer body cleared", "info");
      }
    });
  }

  // Save template button in Gmail footer
  const btnSaveGmail = document.getElementById("btn-save-template-gmail");
  if (btnSaveGmail) {
    btnSaveGmail.addEventListener("click", () => {
      saveCurrentComposerAsNamedTemplate();
    });
  }

  // Gmail header X clear button
  const btnClearHdr = document.getElementById("btn-discard-gmail-header");
  if (btnClearHdr) {
    btnClearHdr.addEventListener("click", () => {
      if (confirm("Are you sure you want to clear the entire composer fields?")) {
        subjectInput.value = "";
        state.template.subject = "";
        ccInput.value = "";
        state.template.cc = "";
        bccInput.value = "";
        state.template.bcc = "";
        if (bodyEditor) bodyEditor.innerHTML = "";
        state.template.body = "";
        saveTemplateToCache();
        updateLivePreview();
        showToast("Composer fields reset", "info");
      }
    });
  }

  // Live preview recipient dropdown trigger
  document.getElementById("preview-recipient-dropdown").addEventListener("change", () => {
    updateLivePreview();
  });

  const previewTemplateSelect = document.getElementById("preview-template-dropdown");
  if (previewTemplateSelect) {
    previewTemplateSelect.addEventListener("change", () => {
      updateLivePreview();
    });
  }

  const btnTogglePreview = document.getElementById("btn-toggle-preview-layout");
  if (btnTogglePreview) {
    btnTogglePreview.addEventListener("click", () => {
      if (state.previewLayout === "all") {
        state.previewLayout = "single";
        btnTogglePreview.innerHTML = `<i data-lucide="grid" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> View All Templates`;
        document.getElementById("preview-template-select-container").style.display = "flex";
      } else {
        state.previewLayout = "all";
        btnTogglePreview.innerHTML = `<i data-lucide="file-text" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> View Single Template`;
        document.getElementById("preview-template-select-container").style.display = "none";
      }
      updateLivePreview();
      lucide.createIcons();
    });
  }

  // File drag and drop (Multi-File & Multi-Sheet)
  const dropzone = document.getElementById("excel-dropzone");
  const fileInput = document.getElementById("excel-file-input");

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files.length > 0) {
        handleExcelFiles(e.dataTransfer.files);
      }
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        handleExcelFiles(e.target.files);
      }
    });
  }

  // Multi-Import setup buttons
  const btnConfirmImport = document.getElementById("btn-confirm-multi-import");
  const btnCancelImport = document.getElementById("btn-cancel-multi-import");
  if (btnConfirmImport) {
    btnConfirmImport.addEventListener("click", confirmMultiImport);
  }
  if (btnCancelImport) {
    btnCancelImport.addEventListener("click", () => {
      state.stagedImportFiles = [];
      document.getElementById("multi-import-panel").classList.add("hidden");
    });
  }

  // Search input in upload tab
  const uploadSearch = document.getElementById("upload-search-input");
  if (uploadSearch) {
    uploadSearch.addEventListener("input", (e) => {
      renderExcelTable(e.target.value.trim());
    });
  }

  // Queue Filters
  const filterTemplate = document.getElementById("queue-filter-template");
  const filterFile = document.getElementById("queue-filter-file");
  const filterAccount = document.getElementById("queue-filter-account");
  const filterStatus = document.getElementById("queue-filter-status");
  const queueSearch = document.getElementById("queue-search-input");

  if (filterTemplate) {
    filterTemplate.addEventListener("change", (e) => {
      state.queueFilters.template = e.target.value;
      renderQueueTable();
    });
  }
  if (filterFile) {
    filterFile.addEventListener("change", (e) => {
      state.queueFilters.file = e.target.value;
      renderQueueTable();
    });
  }
  if (filterAccount) {
    filterAccount.addEventListener("change", (e) => {
      state.queueFilters.account = e.target.value;
      renderQueueTable();
    });
  }
  if (filterStatus) {
    filterStatus.addEventListener("change", (e) => {
      state.queueFilters.status = e.target.value;
      renderQueueTable();
    });
  }
  if (queueSearch) {
    queueSearch.addEventListener("input", (e) => {
      state.queueFilters.search = e.target.value.trim();
      renderQueueTable();
    });
  }

  // Batch Queue Operations
  const btnApplyBatchTemplate = document.getElementById("btn-apply-batch-template");
  const btnApplyBatchAccount = document.getElementById("btn-apply-batch-account");
  const btnDeleteSelectedBatch = document.getElementById("btn-delete-selected-batch");

  if (btnApplyBatchTemplate) {
    btnApplyBatchTemplate.addEventListener("click", applyBatchTemplate);
  }
  if (btnApplyBatchAccount) {
    btnApplyBatchAccount.addEventListener("click", applyBatchAccount);
  }
  if (btnDeleteSelectedBatch) {
    btnDeleteSelectedBatch.addEventListener("click", deleteSelectedQueueRows);
  }

  // Excel table delete selected & select all listeners
  const btnDeleteExcelSelected = document.getElementById("btn-delete-excel-selected");
  if (btnDeleteExcelSelected) {
    btnDeleteExcelSelected.addEventListener("click", deleteSelectedExcelRows);
  }

  const selectAllExcel = document.getElementById("select-all-excel-rows");
  if (selectAllExcel) {
    selectAllExcel.addEventListener("change", (e) => {
      document.querySelectorAll(".excel-row-checkbox").forEach(cb => {
        cb.checked = e.target.checked;
      });
    });
  }

  // Clear list button
  document.getElementById("btn-clear-excel").addEventListener("click", () => {
    state.recipients = [];
    saveRecipientsToCache();
    
    document.getElementById("parsed-data-section").classList.add("hidden");
    document.getElementById("excel-preview-table").querySelector("tbody").innerHTML = "";
    updateSummaryStats();
    populateRecipientDropdown();
    populateTemplateSelector();
    renderQueueTable();
    showToast("Recipient list cleared", "info");
    addLog("Recipient list cleared by user.", "warning");
  });

  // Export Excel template buttons
  const btnDownloadSampleHeader = document.getElementById("btn-download-sample");
  if (btnDownloadSampleHeader) {
    btnDownloadSampleHeader.addEventListener("click", (e) => {
      e.preventDefault();
      downloadSampleExcel();
    });
  }

  const btnDownloadSamplePane = document.getElementById("btn-download-sample-pane");
  if (btnDownloadSamplePane) {
    btnDownloadSamplePane.addEventListener("click", (e) => {
      e.preventDefault();
      downloadSampleExcel();
    });
  }

  // Campaign Report Export buttons
  const btnExportFull = document.getElementById("btn-export-full-report");
  if (btnExportFull) btnExportFull.addEventListener("click", () => exportCampaignExcelReport());

  const btnExportFailed = document.getElementById("btn-export-failed-report");
  if (btnExportFailed) btnExportFailed.addEventListener("click", () => exportCampaignExcelReport("Failed"));

  const btnExportSent = document.getElementById("btn-export-sent-report");
  if (btnExportSent) btnExportSent.addEventListener("click", () => exportCampaignExcelReport("Sent"));

  // Engine start/stop buttons
  const sidebarBtn = document.getElementById("sidebar-toggle-scheduler");
  const deckStart = document.getElementById("btn-start-scheduler-deck");
  const deckStop = document.getElementById("btn-stop-scheduler-deck");

  sidebarBtn.addEventListener("click", toggleScheduler);
  deckStart.addEventListener("click", startSchedulerEngine);
  deckStop.addEventListener("click", stopSchedulerEngine);

  // Reset queue button
  document.getElementById("btn-reset-queue").addEventListener("click", () => {
    state.recipients.forEach(r => {
      r.status = "Pending";
      delete r.error;
    });
    saveRecipientsToCache();
    renderExcelTable();
    renderQueueTable();
    updateSummaryStats();
    showToast("All jobs reset to Pending", "info");
    addLog("Mailing queue reset to Pending.", "system");
  });

  // Log Clear Button
  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    const consoleLogs = document.getElementById("console-logs");
    consoleLogs.innerHTML = `<div class="console-line system">[System] Logs cleared. Engine running: ${state.schedulerActive}</div>`;
  });

  // Send Test Email Button
  document.getElementById("btn-send-test-email").addEventListener("click", sendTestEmail);

  // Reset Application Button
  const btnResetApp = document.getElementById("btn-reset-application");
  if (btnResetApp) {
    btnResetApp.addEventListener("click", async () => {
      if (confirm("Are you absolutely sure you want to reset the entire application? This will clear all SMTP credentials, sender accounts, mailing lists, and email templates, and cannot be undone.")) {
        localStorage.clear();
        state.recipients = [];
        state.templates = [];
        state.settings.senderAccounts = [];
        state.headers = {};
        try {
          if (window.location.protocol.startsWith("http")) {
            await fetch("/api/config", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ settings: {}, templates: [], recipients: [], headers: {} })
            });
          }
        } catch (e) {}
        showToast("Application reset successfully! Reloading...", "success");
        setTimeout(() => {
          location.reload();
        }, 1500);
      }
    });
  }

  // Local Server Test Button
  const testLocalBtn = document.getElementById("btn-test-local-server");
  if (testLocalBtn) {
    testLocalBtn.addEventListener("click", () => {
      testLocalServerConnection();
    });
  }

  // Handle click on status badge to auto-update URL if suggested
  const statusBadge = document.getElementById("local-server-status-badge");
  if (statusBadge) {
    statusBadge.addEventListener("click", () => {
      if (statusBadge.classList.contains("status-suggested")) {
        const suggestedUrl = statusBadge.getAttribute("data-suggested-url");
        if (suggestedUrl) {
          document.getElementById("local-server-url").value = suggestedUrl;
          state.settings.localUrl = suggestedUrl;
          saveSettingsToCache();
          testLocalServerConnection();
          showToast(`Updated server URL to ${suggestedUrl}`, "success");
        }
      }
    });
  }

  // Queue Select All Checkbox
  document.getElementById("select-all-queue-rows").addEventListener("change", (e) => {
    const check = e.target.checked;
    document.querySelectorAll(".queue-row-checkbox").forEach(cb => cb.checked = check);
  });

  const gapInput = document.getElementById("send-gap-seconds");
  if (gapInput) {
    gapInput.value = state.settings.sendDelay || 60;
    gapInput.addEventListener("change", () => {
      const value = Math.max(30, Math.min(300, parseInt(gapInput.value, 10) || 60));
      gapInput.value = value;
      state.settings.sendDelay = value;
      saveSettingsToCache();
      addLog(`Gmail send gap set to ${value} seconds between emails.`, "info");
    });
  }

  // Send selected now button
  document.getElementById("btn-trigger-now-batch").addEventListener("click", () => {
    const selectedIds = [];
    document.querySelectorAll(".queue-row-checkbox:checked").forEach(cb => {
      selectedIds.push(cb.getAttribute("data-id"));
    });

    if (selectedIds.length === 0) {
      showToast("No emails selected in the queue", "warning");
      return;
    }

    addLog(`Manually triggering ${selectedIds.length} email(s) immediately...`, "system");
    
    selectedIds.forEach(id => {
      const rec = state.recipients.find(r => r.id === id);
      if (rec) {
        queueDispatch(rec);
      }
    });
    addLog(`Each person gets their own email. Gmail pace is ${Math.round(state.settings.sendDelay || 60)} seconds between sends.`, "info");

    // Uncheck select all
    document.getElementById("select-all-queue-rows").checked = false;
  });

  // Batch Mark as Sent button
  const btnMarkSent = document.getElementById("btn-mark-selected-sent");
  if (btnMarkSent) {
    btnMarkSent.addEventListener("click", markSelectedAsSent);
  }

  // Batch Reset to Pending button
  const btnMarkPending = document.getElementById("btn-mark-selected-pending");
  if (btnMarkPending) {
    btnMarkPending.addEventListener("click", markSelectedAsPending);
  }

  // Batch Apply Template & Account buttons
  const btnBatchTemp = document.getElementById("btn-apply-batch-template");
  if (btnBatchTemp) btnBatchTemp.addEventListener("click", applyBatchTemplate);

  const btnBatchAcc = document.getElementById("btn-apply-batch-account");
  if (btnBatchAcc) btnBatchAcc.addEventListener("click", applyBatchAccount);

  const btnBatchDel = document.getElementById("btn-delete-selected-batch");
  if (btnBatchDel) btnBatchDel.addEventListener("click", deleteSelectedQueueRows);

  // Template Manager listeners
  const templateSelect = document.getElementById("composer-template-selector");
  if (templateSelect) {
    templateSelect.addEventListener("change", (e) => {
      handleTemplateChange(e.target.value);
    });
  }

  const btnCreateTemplate = document.getElementById("btn-create-template");
  if (btnCreateTemplate) {
    btnCreateTemplate.addEventListener("click", createNewTemplate);
  }

  const btnRenameTemplate = document.getElementById("btn-rename-template");
  if (btnRenameTemplate) {
    btnRenameTemplate.addEventListener("click", renameTemplate);
  }

  const btnDeleteTemplate = document.getElementById("btn-delete-template");
  if (btnDeleteTemplate) {
    btnDeleteTemplate.addEventListener("click", deleteTemplate);
  }

  // Word Document (.docx) Template Importer & Dropzone listeners
  const btnImportDocx = document.getElementById("btn-import-docx-template");
  const btnFooterImportDocx = document.getElementById("btn-footer-import-docx");
  const docxFileInput = document.getElementById("docx-file-input");
  const bodyDropzone = document.getElementById("gmail-body-dropzone");
  const docxOverlay = document.getElementById("docx-drop-overlay");
  const btnClearDocxBanner = document.getElementById("btn-clear-docx-banner");

  if (btnImportDocx && docxFileInput) {
    btnImportDocx.addEventListener("click", () => docxFileInput.click());
  }

  if (btnFooterImportDocx && docxFileInput) {
    btnFooterImportDocx.addEventListener("click", () => docxFileInput.click());
  }

  if (docxFileInput) {
    docxFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        importWordTemplateFile(e.target.files[0]);
        docxFileInput.value = "";
      }
    });
  }

  if (btnClearDocxBanner) {
    btnClearDocxBanner.addEventListener("click", () => {
      const banner = document.getElementById("docx-loaded-banner");
      if (banner) banner.classList.add("hidden");
      if (state.template) delete state.template.docxSource;
      saveTemplateToCache();
    });
  }

  // Drag and Drop Word files onto Gmail Composer Body Dropzone
  if (bodyDropzone && docxOverlay) {
    let dragCounter = 0;

    bodyDropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        docxOverlay.classList.remove("hidden");
      }
    });

    bodyDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    bodyDropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        docxOverlay.classList.add("hidden");
      }
    });

    bodyDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      docxOverlay.classList.add("hidden");

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith(".docx")) {
          importWordTemplateFile(file);
        } else {
          showToast("Please drop a Microsoft Word (.docx) document.", "warning");
        }
      }
    });
  }

  // Bulk Accounts Sheet Import Button
  const btnImportAccounts = document.getElementById("btn-import-accounts-sheet");
  const accountsFileInput = document.getElementById("accounts-file-input");
  if (btnImportAccounts && accountsFileInput) {
    btnImportAccounts.addEventListener("click", () => accountsFileInput.click());
    accountsFileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        importAccountsFromSheetFile(e.target.files[0]);
        accountsFileInput.value = "";
      }
    });
  }

  // Quick Multi-Account Modal buttons
  const btnCloseQuick = document.getElementById("btn-close-quick-accounts-modal");
  const btnCancelQuick = document.getElementById("btn-cancel-quick-accounts");
  const btnSaveQuick = document.getElementById("btn-save-quick-accounts");

  if (btnCloseQuick) btnCloseQuick.addEventListener("click", closeQuickAccountsModal);
  if (btnCancelQuick) btnCancelQuick.addEventListener("click", closeQuickAccountsModal);
  if (btnSaveQuick) btnSaveQuick.addEventListener("click", saveQuickAccounts);
}

// Tab Switching Mechanism
function switchTab(tabId) {
  // Update sidebar buttons
  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.remove("active");
    if (item.getAttribute("data-tab") === tabId) {
      item.classList.add("active");
    }
  });

  // Update tabs views
  document.querySelectorAll(".tab-pane").forEach(pane => {
    pane.classList.remove("active");
  });
  document.getElementById(`tab-${tabId}`).classList.add("active");

  // Update Title and Subtitle in Header
  const title = document.getElementById("current-tab-title");
  const subtitle = document.getElementById("current-tab-subtitle");
  
  if (tabId === "upload") {
    title.textContent = "Import Recipients";
    subtitle.textContent = "Upload your Excel template and preview recipient lists";
  } else if (tabId === "composer") {
    title.textContent = "Email Template Builder";
    subtitle.textContent = "Draft your personalized body and variables";
  } else if (tabId === "preview") {
    title.textContent = "Personalized Campaign Preview";
    subtitle.textContent = "Review each customized email output before scheduling";
    populatePreviewTemplateSelector();
    updateLivePreview();
  } else if (tabId === "queue") {
    title.textContent = "Active Scheduler Engine";
    subtitle.textContent = "Monitor scheduled runs, status logs, and manual overrides";
    renderQueueTable();
  } else if (tabId === "settings") {
    title.textContent = "Sending Mode & Core Settings";
    subtitle.textContent = "Configure local SMTP server relays or web sending APIs";
  } else if (tabId === "help") {
    title.textContent = "Vesper Operations Manual";
    subtitle.textContent = "Helpful instructions, sample templates, and deployment guides";
  }

  lucide.createIcons();
}

// Toggle Visibility of Setting fields depending on active method
function updateMethodFieldsVisibility(method) {
  const el = document.getElementById("fields-localserver");
  if (el) {
    el.classList.remove("hidden");
  }
  testLocalServerConnection();
}

// Toast notification trigger
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  let iconName = "info";
  if (type === "success") iconName = "check-circle-2";
  if (type === "error") iconName = "alert-triangle";
  if (type === "warning") iconName = "alert-circle";

  toast.innerHTML = `
    <i data-lucide="${iconName}" class="toast-icon"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  
  lucide.createIcons();

  // Slide-in animation happens in CSS. Remove after 4s
  setTimeout(() => {
    toast.style.animation = "toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

// Logs terminal writer
function addLog(message, type = "system") {
  const consoleLogs = document.getElementById("console-logs");
  if (!consoleLogs) {
    console.log(`[${type}] ${message}`);
    return;
  }
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = `console-line ${type}`;
  line.textContent = `[${time}] ${message}`;
  
  consoleLogs.appendChild(line);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Sent Registry Duplicate Prevention Helpers
function getRecipientJobKey(rec) {
  if (!rec) return "";
  return rec.id || `${rec.name}_${rec.rawSDate || rec.date}_${rec.email}`;
}

function isJobAlreadySent(rec) {
  if (!rec) return false;
  const key = getRecipientJobKey(rec);
  if (!state.sentRegistry) state.sentRegistry = [];
  return state.sentRegistry.includes(key);
}

function markJobAsSent(rec) {
  if (!rec) return;
  const key = getRecipientJobKey(rec);
  if (!state.sentRegistry) state.sentRegistry = [];
  if (!state.sentRegistry.includes(key)) {
    state.sentRegistry.push(key);
    localStorage.setItem("vesper_sent_registry", JSON.stringify(state.sentRegistry));
    saveConfigToServer();
  }
}

function syncSentRegistryWithRecipients() {
  if (!state.sentRegistry) state.sentRegistry = [];
  
  if (state.recipients && Array.isArray(state.recipients)) {
    state.recipients.forEach(r => {
      const key = getRecipientJobKey(r);
      if (r.status === "Sent" && key) {
        if (!state.sentRegistry.includes(key)) {
          state.sentRegistry.push(key);
        }
      }
    });
  }

  localStorage.setItem("vesper_sent_registry", JSON.stringify(state.sentRegistry));
}

// Parse dates/times from spreadsheets (supports single combined string or separate date & time columns)
function parseScheduleTime(dateVal, timeVal) {
  // Swap if only timeVal is passed in dateVal slot
  if ((dateVal === undefined || dateVal === null || dateVal === "") && timeVal) {
    dateVal = timeVal;
    timeVal = null;
  }

  if (!dateVal && !timeVal) return null;

  // Helper: parse time component
  function parseTimeParts(tVal) {
    if (typeof tVal === "number") {
      // Excel fractional day for time, e.g. 0.5 = 12:00 PM, 0.60416 = 14:30
      const totalSeconds = Math.round((tVal % 1) * 86400);
      const hours = Math.floor(totalSeconds / 3600) % 24;
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return { hours, minutes, seconds, hasExplicitTime: true };
    }
    if (typeof tVal === "string") {
      const trimmed = tVal.trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (match) {
        let hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = match[3] ? parseInt(match[3]) : 0;
        const ampm = match[4];
        if (ampm) {
          if (ampm.toUpperCase() === "PM" && hours < 12) hours += 12;
          if (ampm.toUpperCase() === "AM" && hours === 12) hours = 0;
        }
        return { hours, minutes, seconds, hasExplicitTime: true };
      }
    }
    return null;
  }

  // Helper: parse date component
  function parseDateParts(dVal) {
    if (dVal instanceof Date) {
      return isNaN(dVal.getTime()) ? null : {
        year: dVal.getFullYear(),
        monthIndex: dVal.getMonth(),
        day: dVal.getDate(),
        hours: dVal.getHours(),
        minutes: dVal.getMinutes(),
        seconds: dVal.getSeconds(),
        hasExplicitTime: dVal.getHours() > 0 || dVal.getMinutes() > 0
      };
    }
    if (typeof dVal === "number") {
      // Excel Serial Date number
      const baseDate = new Date(1899, 11, 30);
      const d = new Date(baseDate.getTime() + Math.floor(dVal) * 86400000);
      if (isNaN(d.getTime())) return null;

      // Extract time fraction if present in serial number
      const frac = dVal % 1;
      let hours = 0, minutes = 0, seconds = 0;
      let hasExplicitTime = false;
      if (frac > 0) {
        const totSec = Math.round(frac * 86400);
        hours = Math.floor(totSec / 3600) % 24;
        minutes = Math.floor((totSec % 3600) / 60);
        seconds = totSec % 60;
        hasExplicitTime = true;
      }
      return {
        year: d.getFullYear(),
        monthIndex: d.getMonth(),
        day: d.getDate(),
        hours, minutes, seconds, hasExplicitTime
      };
    }
    if (typeof dVal === "string") {
      const str = dVal.trim();
      if (!str) return null;

      // YYYY-MM-DD or DD/MM/YYYY or MM/DD/YYYY date-only regex
      const dateOnlyMatch = str.match(/^(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})$/);
      if (dateOnlyMatch) {
        let p1 = parseInt(dateOnlyMatch[1]);
        let p2 = parseInt(dateOnlyMatch[2]);
        let p3 = parseInt(dateOnlyMatch[3]);

        let year, monthIndex, day;
        if (p1 > 1000) {
          year = p1;
          monthIndex = p2 - 1;
          day = p3;
        } else if (p3 > 1000) {
          year = p3;
          if (p1 > 12) {
            day = p1;
            monthIndex = p2 - 1;
          } else {
            monthIndex = p1 - 1;
            day = p2;
          }
        }
        if (year && monthIndex >= 0 && day) {
          return { year, monthIndex, day, hours: 9, minutes: 0, seconds: 0, hasExplicitTime: false };
        }
      }

      const fullDate = new Date(str);
      if (!isNaN(fullDate.getTime())) {
        return {
          year: fullDate.getFullYear(),
          monthIndex: fullDate.getMonth(),
          day: fullDate.getDate(),
          hours: fullDate.getHours(),
          minutes: fullDate.getMinutes(),
          seconds: fullDate.getSeconds(),
          hasExplicitTime: str.includes(":")
        };
      }
    }
    return null;
  }

  // When BOTH dateVal and timeVal are supplied (e.g. S_Date + S_Time)
  if (dateVal && timeVal) {
    const dParts = parseDateParts(dateVal);
    const tParts = parseTimeParts(timeVal);

    if (dParts && tParts) {
      return new Date(dParts.year, dParts.monthIndex, dParts.day, tParts.hours, tParts.minutes, tParts.seconds);
    }
    if (dParts) {
      const combinedStr = `${String(dateVal).trim()} ${String(timeVal).trim()}`;
      const combinedDate = new Date(combinedStr);
      if (!isNaN(combinedDate.getTime())) return combinedDate;
      return new Date(dParts.year, dParts.monthIndex, dParts.day, dParts.hours, dParts.minutes, dParts.seconds);
    }
  }

  // Single parameter fallback
  const tPartsOnly = parseTimeParts(dateVal);
  if (tPartsOnly) {
    const today = new Date();
    today.setHours(tPartsOnly.hours, tPartsOnly.minutes, tPartsOnly.seconds, 0);
    if (today.getTime() < Date.now()) {
      today.setDate(today.getDate() + 1);
    }
    return today;
  }

  const dPartsOnly = parseDateParts(dateVal);
  if (dPartsOnly) {
    return new Date(dPartsOnly.year, dPartsOnly.monthIndex, dPartsOnly.day, dPartsOnly.hours, dPartsOnly.minutes, dPartsOnly.seconds);
  }

  const fallback = new Date(String(dateVal));
  return isNaN(fallback.getTime()) ? null : fallback;
}

// Handle imported spreadsheet parsing
// Handle importing multiple spreadsheet files and multi-sheet workbooks
function handleExcelFiles(files) {
  if (!files || files.length === 0) return;

  state.stagedImportFiles = [];
  const fileList = Array.from(files);
  let filesRead = 0;

  addLog(`Reading ${fileList.length} spreadsheet file(s)...`, "system");

  fileList.forEach(file => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target.result;
        const workbook = XLSX.read(data, { type: "binary" });

        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: "A", raw: false, defval: "" });

          if (rows && rows.length > 0) {
            // Find auto-detected template ID if sheet name matches template name
            let autoTemplateId = state.activeTemplateId;
            const matchedTemplate = state.templates.find(t => t.name.trim().toLowerCase() === sheetName.trim().toLowerCase());
            if (matchedTemplate) {
              autoTemplateId = matchedTemplate.id;
            }

            state.stagedImportFiles.push({
              fileName: file.name,
              sheetName: sheetName,
              rows: rows,
              selectedTemplateId: autoTemplateId
            });
          }
        });
      } catch (err) {
        console.error(`Error parsing file ${file.name}:`, err);
        showToast(`Failed to parse ${file.name}: ${err.message}`, "error");
      } finally {
        filesRead++;
        if (filesRead === fileList.length) {
          showMultiImportSetupPanel();
        }
      }
    };

    reader.onerror = () => {
      filesRead++;
      showToast(`Error reading file ${file.name}`, "error");
      if (filesRead === fileList.length) {
        showMultiImportSetupPanel();
      }
    };

    reader.readAsBinaryString(file);
  });
}

// Display the multi-import template assignment setup panel
function showMultiImportSetupPanel() {
  if (state.stagedImportFiles.length === 0) {
    showToast("No valid rows found in selected files.", "warning");
    return;
  }

  const panel = document.getElementById("multi-import-panel");
  const countBadge = document.getElementById("multi-import-files-count");
  const listContainer = document.getElementById("multi-import-items-list");

  if (!panel || !listContainer) return;

  countBadge.textContent = `${state.stagedImportFiles.length} Sheet(s) Ready`;
  listContainer.innerHTML = "";

  state.stagedImportFiles.forEach((staged, idx) => {
    const itemRow = document.createElement("div");
    itemRow.style.display = "flex";
    itemRow.style.alignItems = "center";
    itemRow.style.justifyContent = "space-between";
    itemRow.style.padding = "8px 12px";
    itemRow.style.background = "var(--bg-secondary)";
    itemRow.style.border = "1px solid var(--border-color)";
    itemRow.style.borderRadius = "var(--radius-sm)";
    itemRow.style.gap = "12px";
    itemRow.style.flexWrap = "wrap";

    const labelHtml = `
      <div style="display: flex; flex-direction: column;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          <i data-lucide="file-spreadsheet" style="width: 14px; height: 14px; color: var(--color-indigo);"></i>
          ${escapeHtml(staged.fileName)} <span class="badge badge-outline-gray" style="font-size: 10px;">${escapeHtml(staged.sheetName)}</span>
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">${staged.rows.length} total rows parsed</span>
      </div>
    `;

    const selectsWrapper = document.createElement("div");
    selectsWrapper.style.display = "flex";
    selectsWrapper.style.gap = "8px";
    selectsWrapper.style.alignItems = "center";
    selectsWrapper.style.flexWrap = "wrap";

    // Template selector
    const tempSelect = document.createElement("select");
    tempSelect.className = "form-control xs-input";
    tempSelect.style.padding = "4px 8px";
    tempSelect.style.fontSize = "12px";
    tempSelect.style.maxWidth = "200px";

    const autoOpt = document.createElement("option");
    autoOpt.value = "auto";
    autoOpt.textContent = "⚡ Auto-Detect Template";
    tempSelect.appendChild(autoOpt);

    state.templates.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `Template: ${t.name}`;
      if (staged.selectedTemplateId === t.id) {
        opt.selected = true;
      }
      tempSelect.appendChild(opt);
    });

    tempSelect.addEventListener("change", (e) => {
      staged.selectedTemplateId = e.target.value;
    });

    // Sender Account selector
    const accSelect = document.createElement("select");
    accSelect.className = "form-control xs-input";
    accSelect.style.padding = "4px 8px";
    accSelect.style.fontSize = "12px";
    accSelect.style.maxWidth = "200px";

    const autoAccOpt = document.createElement("option");
    autoAccOpt.value = "auto";
    autoAccOpt.textContent = "✉️ Sender Email from Sheet";
    accSelect.appendChild(autoAccOpt);

    (state.settings.senderAccounts || []).forEach(acc => {
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = `Sender: ${acc.label}`;
      accSelect.appendChild(opt);
    });

    accSelect.addEventListener("change", (e) => {
      staged.selectedSenderAccountId = e.target.value;
    });

    selectsWrapper.appendChild(tempSelect);
    selectsWrapper.appendChild(accSelect);

    itemRow.innerHTML = labelHtml;
    itemRow.appendChild(selectsWrapper);
    listContainer.appendChild(itemRow);
  });

  panel.classList.remove("hidden");
  lucide.createIcons();
}

// Confirm multi-import and process staged rows
function confirmMultiImport() {
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || "append";
  
  if (mode === "replace") {
    state.recipients = [];
  }

  let totalAdded = 0;
  let totalDiscarded = 0;

  state.stagedImportFiles.forEach(staged => {
    const { added, invalid } = processImportedRows(staged.rows, staged.fileName, staged.sheetName, staged.selectedTemplateId, staged.selectedSenderAccountId);
    totalAdded += added;
    totalDiscarded += invalid;
  });

  state.stagedImportFiles = [];
  document.getElementById("multi-import-panel").classList.add("hidden");

  saveRecipientsToCache();
  
  // Show section and update views
  document.getElementById("parsed-data-section").classList.remove("hidden");
  renderExcelTable();
  updateSummaryStats();
  populateRecipientDropdown();
  populateTemplateSelector();
  renderQueueTable();
  checkUnconfiguredSenderAccounts();

  showToast(`Successfully imported ${totalAdded} recipients!`, "success");
  addLog(`Batch Import complete: Added ${totalAdded} recipients across ${state.recipients.length} total queue items. Discarded ${totalDiscarded} incomplete rows.`, "success");
}

// Clean and map imported columns to standardized format
function processImportedRows(rows, fileName = "Upload.xlsx", sheetName = "Sheet1", defaultTemplateId = "auto", defaultSenderAccountId = "auto") {
  // Find the header row (the first row containing a field like 'email' or 'mail')
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const values = Object.values(rows[i]).map(v => String(v).toLowerCase());
    if (values.some(v => v.includes("email") || v.includes("mail"))) {
      headerRowIndex = i;
      break;
    }
  }

  const headerRow = rows[headerRowIndex];
  
  // Extract all valid column letter keys
  const colLetters = Object.keys(headerRow).filter(k => /^[A-Z]+$/i.test(k));
  
  // Merge or save to state.headers
  colLetters.forEach(col => {
    state.headers[col] = String(headerRow[col]).trim();
  });

  const getColumnLetter = (headerRow, alternatives) => {
    for (const alt of alternatives) {
      const match = Object.keys(headerRow).find(key => {
        const val = String(headerRow[key]).trim().toLowerCase();
        return val === alt.toLowerCase();
      });
      if (match) return match;
    }
    // Fallback: contains match
    for (const alt of alternatives) {
      const match = Object.keys(headerRow).find(key => {
        const val = String(headerRow[key]).trim().toLowerCase();
        return val.includes(alt.toLowerCase());
      });
      if (match) return match;
    }
    return null;
  };

  const nameCol = getColumnLetter(headerRow, ["Name", "First Name", "Recipient Name", "Full Name", "Contact Name"]);
  const emailCol = getColumnLetter(headerRow, ["Email", "Email Address", "Mail", "EmailID"]);
  const affCol = getColumnLetter(headerRow, ["Affiliation", "Company", "Organization", "Aff"]);
  const dateCol = getColumnLetter(headerRow, ["Date", "Mail Date", "Scheduled Date"]);
  const techSchedCol = getColumnLetter(headerRow, ["Session", "session", "Technical Schedual Name", "Technical Schedule Name", "Tech Schedule", "Tech Schedual", "Schedule Name", "tsname"]);
  const timeCol = getColumnLetter(headerRow, ["Time", "Event Time", "Time Tag"]);
  const ccCol = getColumnLetter(headerRow, ["CC", "Cc", "Cc Email", "Carbon Copy"]);
  const bccCol = getColumnLetter(headerRow, ["BCC", "Bcc", "Bcc Email", "Blind Carbon Copy"]);
  const senderNameCol = getColumnLetter(headerRow, [
    "Sender Name", "SenderName", "FromName", "From Name", "Sender_Name", "Sender-Name",
    "Account Name", "AccountName", "Display Name", "DisplayName", "Sender Title", "Sender_Title"
  ]);
  let senderCol = getColumnLetter(headerRow, [
    "Account Email", "Account_Email", "AccountEmail", "Account Emails", "Account_Emails", "AccountEmails",
    "Sender Email", "SenderEmail", "Sender Account", "SenderAccount", "Sender_Account",
    "From Email", "From_Email", "FromEmail", "From Account", "From_Account", "FromAccount",
    "Send From", "SendFrom", "Sending Account", "Sending_Account", "SendingAccount",
    "User Email", "UserEmail", "Mail Account", "Email Account", "EmailAccount", "Sender Mail", "Account Mail",
    "Sender", "From", "Account", "Accounts"
  ]);

  // If senderCol accidentally matched the senderNameCol header, disambiguate
  if (senderCol && senderNameCol && senderCol === senderNameCol) {
    senderCol = null;
  }
  const actionCol = getColumnLetter(headerRow, ["Action", "Type", "Method", "Mode", "Scheduling Action"]);
  const sDateCol = getColumnLetter(headerRow, ["S_Date", "S-Date", "SDate", "S Date", "Schedule Date", "Send Date", "Date"]);
  const sTimeCol = getColumnLetter(headerRow, ["S_Time", "S-Time", "STime", "S Time", "Schedule Time", "Send Time", "Time"]);
  const templateCol = getColumnLetter(headerRow, ["Template", "Template Name", "TemplateID", "Template ID", "Mail Template", "Email Template"]);

  let addedCount = 0;
  let invalidCounter = 0;

  // Process data rows
  for (let index = headerRowIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    
    const getStringValue = (val) => {
      if (val === undefined || val === null) return "";
      return String(val).trim();
    };

    const name = nameCol ? getStringValue(row[nameCol]) : "";
    const email = emailCol ? getStringValue(row[emailCol]) : "";
    const affiliation = affCol ? getStringValue(row[affCol]) : "Independent";
    const date = dateCol ? getStringValue(row[dateCol]) : "";
    const techScheduleName = techSchedCol ? getStringValue(row[techSchedCol]) : "";
    const time = timeCol ? getStringValue(row[timeCol]) : "";
    const cc = ccCol ? getStringValue(row[ccCol]) : "";
    const bcc = bccCol ? getStringValue(row[bccCol]) : "";
    
    const rawSenderVal = senderCol ? getStringValue(row[senderCol]) : "";
    const rawSenderNameVal = senderNameCol ? getStringValue(row[senderNameCol]) : "";

    let derivedSenderName = rawSenderNameVal;
    let derivedSender = rawSenderVal;

    // Fallback: search row fields for any column with "sender name" if derivedSenderName is empty
    if (!derivedSenderName) {
      for (const [k, v] of Object.entries(row)) {
        const headerText = String(headerRow[k] || k).trim().toLowerCase();
        if ((headerText.includes("sender") || headerText.includes("from")) && headerText.includes("name")) {
          const valStr = getStringValue(v);
          if (valStr) {
            derivedSenderName = valStr;
            break;
          }
        }
      }
    }

    if (rawSenderVal) {
      if (rawSenderVal.includes('<') && rawSenderVal.includes('>')) {
        const namePart = rawSenderVal.split('<')[0].trim().replace(/^["'\s]+|["'\s]+$/g, '');
        const emailPart = rawSenderVal.split('<')[1].split('>')[0].trim();
        if (!derivedSenderName && namePart) derivedSenderName = namePart;
        derivedSender = emailPart;
      } else if (!rawSenderVal.includes('@') || rawSenderVal.includes(' ')) {
        if (!derivedSenderName) derivedSenderName = rawSenderVal;
        derivedSender = rawSenderVal;
      } else {
        derivedSender = rawSenderVal;
      }
    }

    const actionStr = actionCol ? String(row[actionCol]).trim().toLowerCase() : "";
    const rawSDate = sDateCol ? row[sDateCol] : (dateCol ? row[dateCol] : "");
    const rawSTime = sTimeCol ? row[sTimeCol] : (timeCol ? row[timeCol] : "");
    const rowTemplateVal = templateCol ? getStringValue(row[templateCol]) : "";

    // Require Name and Email
    if (!name || !email) {
      invalidCounter++;
      continue;
    }

    // Determine row's template
    let rowTemplateId = "";
    if (rowTemplateVal) {
      const matched = state.templates.find(t => 
        t.id.toLowerCase() === rowTemplateVal.toLowerCase() || 
        t.name.toLowerCase() === rowTemplateVal.toLowerCase()
      );
      if (matched) rowTemplateId = matched.id;
    }

    if (!rowTemplateId && defaultTemplateId && defaultTemplateId !== "auto") {
      rowTemplateId = defaultTemplateId;
    }

    if (!rowTemplateId) {
      // Auto match sheet name to template
      const matchedSheetTemp = state.templates.find(t => t.name.toLowerCase() === sheetName.toLowerCase());
      rowTemplateId = matchedSheetTemp ? matchedSheetTemp.id : state.activeTemplateId;
    }

    const parsedTime = parseScheduleTime(rawSDate, rawSTime);
    addedCount++;

    // Check if recipient email was ALREADY SENT previously
    let initialStatus = "Pending";
    let initialError = undefined;
    const newRowId = `recipient-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    if (isJobAlreadySent({ id: newRowId, name: name, rawSDate: rawSDate, email: email })) {
      initialStatus = "Sent";
      initialError = "Already sent previously (Duplicate Protection Guard)";
    }

    // Match sender account
    let matchedAcc = null;
    const lookupSender = (derivedSender || "").toLowerCase();
    if (lookupSender && state.settings.senderAccounts) {
      matchedAcc = state.settings.senderAccounts.find(acc => 
        acc.user.toLowerCase() === lookupSender || 
        acc.label.toLowerCase() === lookupSender ||
        (acc.user && acc.user.toLowerCase().includes(lookupSender))
      );
    }
    
    let senderAccountId = "";
    if (matchedAcc) {
      senderAccountId = matchedAcc.id;
    } else if (defaultSenderAccountId && defaultSenderAccountId !== "auto") {
      senderAccountId = defaultSenderAccountId;
      const explicitAcc = (state.settings.senderAccounts || []).find(a => a.id === defaultSenderAccountId);
      if (explicitAcc && !derivedSender) {
        derivedSender = explicitAcc.user;
      }
    } else {
      senderAccountId = state.template.senderAccountId || "";
    }

    // Send vs Draft comes only from the Configuration page.
    let action = getConfiguredAction();

    // Capture ALL raw column values by letter
    const colValues = {};
    colLetters.forEach(col => {
      colValues[col] = getStringValue(row[col]);
    });

    state.recipients.push({
      id: newRowId,
      name: name,
      email: email,
      affiliation: affiliation,
      date: date || String(rawSDate || ""),
      techScheduleName: techScheduleName,
      session: techScheduleName,
      time: time || String(rawSTime || ""),
      rawSDate: String(rawSDate || ""),
      rawSTime: String(rawSTime || ""),
      rawTime: String(rawSTime || rawSDate || "Now"),
      parsedTime: parsedTime,
      templateId: rowTemplateId,
      sourceFile: fileName,
      sourceSheet: sheetName,
      senderAccountId: senderAccountId,
      sender: derivedSender || (matchedAcc ? matchedAcc.user : ""),
      senderName: derivedSenderName,
      action: action,
      cc: cc || state.template.cc || "",
      bcc: bcc || state.template.bcc || "",
      status: initialStatus,
      error: initialError,
      colValues: colValues
    });
  }

  // Re-build column headers and merge tags dropdown dynamically
  updateMergeTagsMenu(colLetters, headerRow);
  updateTableHeadersWithLetters({
    name: nameCol,
    email: emailCol,
    aff: affCol,
    date: dateCol,
    session: techSchedCol,
    time: timeCol
  });

  return { added: addedCount, invalid: invalidCounter };
}

// Render imported rows in the upload panel
function renderExcelTable(searchQuery = "") {
  const tbody = document.getElementById("excel-preview-table").querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  let list = state.recipients;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(r => 
      r.name.toLowerCase().includes(q) || 
      r.email.toLowerCase().includes(q) || 
      r.affiliation.toLowerCase().includes(q) ||
      (r.sender || "").toLowerCase().includes(q) ||
      (r.sourceFile || "").toLowerCase().includes(q)
    );
  }

  list.forEach((rec, idx) => {
    const row = document.createElement("tr");
    
    const displayTime = rec.parsedTime 
      ? rec.parsedTime.toLocaleString() 
      : `<span class="text-coral">Immediate</span>`;

    const tObj = state.templates.find(t => t.id === rec.templateId) || state.templates[0];
    const templateName = tObj ? tObj.name : "Default";
    const fileSourceStr = `${escapeHtml(rec.sourceFile || 'Upload.xlsx')} (${escapeHtml(rec.sourceSheet || 'Sheet1')})`;

    let senderAccountBadge = `<span class="badge badge-outline-gray">Default Sender</span>`;
    let matchedAcc = (state.settings.senderAccounts || []).find(a => a.id === rec.senderAccountId);
    if (!matchedAcc && rec.sender) {
      matchedAcc = (state.settings.senderAccounts || []).find(a => a.user.toLowerCase() === rec.sender.toLowerCase() || a.label.toLowerCase() === rec.sender.toLowerCase());
    }

    let senderNameHtml = "";
    if (rec.senderName && rec.senderName.trim()) {
      senderNameHtml = `<div style="font-size: 11px; font-weight: 700; color: var(--color-indigo); margin-bottom: 3px; display: flex; align-items: center; gap: 4px;" title="Sender Name from Excel: ${escapeHtml(rec.senderName.trim())}"><i data-lucide="user-check" style="width:11px; height:11px;"></i>${escapeHtml(rec.senderName.trim())}</div>`;
    }

    if (matchedAcc) {
      senderAccountBadge = `<span class="badge badge-indigo" title="Mapped Sender Account"><i data-lucide="mail" style="width:11px; height:11px; margin-right:3px;"></i>${escapeHtml(matchedAcc.label)}</span>`;
    } else if (rec.sender) {
      senderAccountBadge = `<span class="badge badge-outline-red" title="Sender email mentioned in sheet, but no SMTP credentials added in Settings yet"><i data-lucide="alert-circle" style="width:11px; height:11px; margin-right:3px;"></i>${escapeHtml(rec.sender)} (Unconfigured)</span>`;
    }

    row.innerHTML = `
      <td style="text-align: center;"><input type="checkbox" class="excel-row-checkbox" data-id="${rec.id}"></td>
      <td>${idx + 1}</td>
      <td class="text-bold">${escapeHtml(rec.name)}</td>
      <td class="text-teal">${escapeHtml(rec.email)}</td>
      <td>${escapeHtml(rec.affiliation)}</td>
      <td><span class="badge badge-indigo" title="Assigned Template">${escapeHtml(templateName)}</span></td>
      <td>${senderNameHtml}${senderAccountBadge}</td>
      <td><span class="badge badge-outline-gray">${fileSourceStr}</span></td>
      <td>${escapeHtml(rec.date || "—")}</td>
      <td>${escapeHtml(rec.techScheduleName || "—")}</td>
      <td><code>${escapeHtml(rec.rawSDate || "—")}</code></td>
      <td><code>${escapeHtml(rec.rawSTime || "Now")}</code></td>
      <td>${displayTime}</td>
      <td style="text-align: center;">
        <button class="btn btn-danger btn-sm btn-delete-excel-row" data-id="${rec.id}" title="Delete Contact" style="padding: 3px 8px; font-size: 11px;">
          <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
        </button>
      </td>
    `;
    tbody.appendChild(row);
  });

  // Re-bind row delete buttons in excel table
  tbody.querySelectorAll(".btn-delete-excel-row").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      deleteRecipient(id);
    });
  });

  lucide.createIcons();
}

// Populate Filter Options for Queue
function updateQueueFilterDropdowns() {
  const templateSelect = document.getElementById("queue-filter-template");
  const fileSelect = document.getElementById("queue-filter-file");
  const accountSelect = document.getElementById("queue-filter-account");
  const batchTemplateSelect = document.getElementById("batch-assign-template-select");
  const batchAccountSelect = document.getElementById("batch-assign-account-select");

  if (templateSelect) {
    const currTemp = state.queueFilters.template || "all";
    templateSelect.innerHTML = `<option value="all">All Templates (${state.recipients.length})</option>`;
    
    state.templates.forEach(t => {
      const count = state.recipients.filter(r => (r.templateId || state.activeTemplateId) === t.id).length;
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name} (${count})`;
      if (t.id === currTemp) opt.selected = true;
      templateSelect.appendChild(opt);
    });
  }

  if (fileSelect) {
    const currFile = state.queueFilters.file || "all";
    fileSelect.innerHTML = `<option value="all">All Files</option>`;

    const distinctFiles = Array.from(new Set(state.recipients.map(r => r.sourceFile || "Upload.xlsx")));
    distinctFiles.forEach(fileName => {
      const count = state.recipients.filter(r => (r.sourceFile || "Upload.xlsx") === fileName).length;
      const opt = document.createElement("option");
      opt.value = fileName;
      opt.textContent = `${fileName} (${count})`;
      if (fileName === currFile) opt.selected = true;
      fileSelect.appendChild(opt);
    });
  }

  if (accountSelect) {
    const currAcc = state.queueFilters.account || "all";
    accountSelect.innerHTML = `<option value="all">All Accounts (${state.recipients.length})</option>`;
    
    (state.settings.senderAccounts || []).forEach(acc => {
      const count = state.recipients.filter(r => r.senderAccountId === acc.id).length;
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = `${acc.label} (${count})`;
      if (acc.id === currAcc) opt.selected = true;
      accountSelect.appendChild(opt);
    });
  }

  if (batchTemplateSelect) {
    batchTemplateSelect.innerHTML = "";
    state.templates.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      batchTemplateSelect.appendChild(opt);
    });
  }

  if (batchAccountSelect) {
    batchAccountSelect.innerHTML = "";
    (state.settings.senderAccounts || []).forEach(acc => {
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = `${acc.label} (${acc.user})`;
      batchAccountSelect.appendChild(opt);
    });
  }
}

// Render the active queue in the Queue manager panel
function renderQueueTable() {
  updateQueueFilterDropdowns();

  const tbody = document.getElementById("queue-details-table").querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (state.recipients.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="text-center text-muted" style="padding: 40px 16px;">No emails loaded in the schedule queue yet. Import an Excel file first.</td>
      </tr>
    `;
    return;
  }

  // Filter recipients
  let filtered = state.recipients;
  const fTemp = state.queueFilters.template;
  const fFile = state.queueFilters.file;
  const fAcc = state.queueFilters.account;
  const fStatus = state.queueFilters.status;
  const fSearch = state.queueFilters.search;

  if (fTemp && fTemp !== "all") {
    filtered = filtered.filter(r => (r.templateId || state.activeTemplateId) === fTemp);
  }
  if (fFile && fFile !== "all") {
    filtered = filtered.filter(r => (r.sourceFile || "Upload.xlsx") === fFile);
  }
  if (fAcc && fAcc !== "all") {
    filtered = filtered.filter(r => r.senderAccountId === fAcc);
  }
  if (fStatus && fStatus !== "all") {
    filtered = filtered.filter(r => r.status === fStatus);
  }
  if (fSearch) {
    const q = fSearch.toLowerCase();
    filtered = filtered.filter(r => 
      r.name.toLowerCase().includes(q) || 
      r.email.toLowerCase().includes(q) || 
      r.affiliation.toLowerCase().includes(q) ||
      (r.sender || "").toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="text-center text-muted" style="padding: 30px 16px;">No jobs match the active filters.</td>
      </tr>
    `;
    return;
  }

  filtered.forEach(rec => {
    const row = document.createElement("tr");
    row.id = `row-${rec.id}`;
    
    // Checkbox column
    const checkTd = document.createElement("td");
    checkTd.innerHTML = `<input type="checkbox" class="queue-row-checkbox" data-id="${rec.id}">`;
    row.appendChild(checkTd);

    // Name
    const nameTd = document.createElement("td");
    nameTd.className = "text-bold";
    nameTd.textContent = rec.name;
    row.appendChild(nameTd);

    // Email
    const emailTd = document.createElement("td");
    emailTd.className = "text-teal";
    emailTd.textContent = rec.email;
    row.appendChild(emailTd);

    // Template Dropdown
    const templateTd = document.createElement("td");
    const templateSelect = document.createElement("select");
    templateSelect.className = "form-control xs-input";
    templateSelect.style.padding = "4px 8px";
    templateSelect.style.fontSize = "12px";
    templateSelect.style.height = "auto";
    
    state.templates.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      if (rec.templateId === t.id || (!rec.templateId && t.id === state.activeTemplateId)) {
        opt.selected = true;
      }
      templateSelect.appendChild(opt);
    });
    
    templateSelect.addEventListener("change", (e) => {
      rec.templateId = e.target.value;
      saveRecipientsToCache();
      const tName = state.templates.find(temp => temp.id === rec.templateId)?.name || 'Default';
      addLog(`Updated template for ${rec.name} to "${tName}".`, "system");
      updateQueueFilterDropdowns();
      populateTemplateSelector();
    });
    templateTd.appendChild(templateSelect);
    row.appendChild(templateTd);

    // Source File / Sheet Column
    const sourceTd = document.createElement("td");
    const fileStr = escapeHtml(rec.sourceFile || "Upload.xlsx");
    const sheetStr = escapeHtml(rec.sourceSheet || "Sheet1");
    sourceTd.innerHTML = `<span class="badge badge-outline-gray" style="font-size: 11px;" title="${fileStr}">${fileStr} (${sheetStr})</span>`;
    row.appendChild(sourceTd);

    // Sender Account Dropdown
    const senderTd = document.createElement("td");
    const queueSenderName = getFinalSenderName(rec, null);
    if (queueSenderName && queueSenderName.trim()) {
      const nameDiv = document.createElement("div");
      nameDiv.style.cssText = "font-size: 11px; font-weight: 700; color: var(--color-indigo); margin-bottom: 3px; display: flex; align-items: center; gap: 4px;";
      nameDiv.innerHTML = `<i data-lucide="user-check" style="width:11px; height:11px;"></i>${escapeHtml(queueSenderName.trim())}`;
      senderTd.appendChild(nameDiv);
    }
    const senderSelect = document.createElement("select");
    senderSelect.className = "form-control xs-input";
    senderSelect.style.padding = "4px 8px";
    senderSelect.style.fontSize = "12px";
    senderSelect.style.height = "auto";
    
    const senderAccounts = state.settings.senderAccounts || [];
    let isMatched = false;

    senderAccounts.forEach(acc => {
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = `${acc.label} (${acc.user})`;
      if (rec.senderAccountId === acc.id) {
        opt.selected = true;
        isMatched = true;
      }
      senderSelect.appendChild(opt);
    });

    if (!isMatched && rec.sender) {
      const unconfOpt = document.createElement("option");
      unconfOpt.value = "";
      unconfOpt.textContent = `⚠️ Unconfigured: ${rec.sender}`;
      unconfOpt.selected = true;
      senderSelect.prepend(unconfOpt);
    } else if (senderAccounts.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "-- No Accounts Configured --";
      senderSelect.appendChild(opt);
    }
    
    senderSelect.addEventListener("change", (e) => {
      rec.senderAccountId = e.target.value;
      saveRecipientsToCache();
      const acc = (state.settings.senderAccounts || []).find(a => a.id === rec.senderAccountId);
      if (acc) {
        rec.sender = acc.user;
      }
      addLog(`Updated sender for ${rec.name} to ${acc ? acc.label : 'Default'}.`, "system");
      renderExcelTable();
    });
    senderTd.appendChild(senderSelect);
    row.appendChild(senderTd);

    const actionTd = document.createElement("td");
    const configuredAction = getConfiguredAction();
    const actionLabel = document.createElement("div");
    actionLabel.style.fontSize = "12px";
    actionLabel.style.fontWeight = "700";
    actionLabel.style.color = configuredAction === "draft" ? "#d97706" : "var(--color-indigo)";
    actionLabel.textContent = configuredAction === "draft" ? "Draft (IMAP)" : "Send (SMTP)";
    const actionHint = document.createElement("div");
    actionHint.style.fontSize = "10px";
    actionHint.style.color = "var(--text-muted)";
    actionHint.style.marginTop = "2px";
    actionHint.textContent = "Set on Configuration";
    actionTd.appendChild(actionLabel);
    actionTd.appendChild(actionHint);
    row.appendChild(actionTd);

    // Target schedule time
    const targetTd = document.createElement("td");
    const timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.className = "form-control xs-input";
    timeInput.style.padding = "4px 8px";
    timeInput.style.fontSize = "12px";
    timeInput.style.height = "auto";
    timeInput.value = formatDateTimeLocal(rec.parsedTime);
    timeInput.addEventListener("change", (e) => {
      const newVal = e.target.value;
      if (newVal) {
        rec.parsedTime = new Date(newVal);
      } else {
        rec.parsedTime = null; // Immediate
      }
      saveRecipientsToCache();
      updateSummaryStats();
      addLog(`Updated scheduled time for ${rec.name} to ${rec.parsedTime ? rec.parsedTime.toLocaleString() : 'Immediate'}.`, "system");
    });
    targetTd.appendChild(timeInput);
    row.appendChild(targetTd);

    // Remaining countdown cell
    const remainingTd = document.createElement("td");
    remainingTd.id = `countdown-${rec.id}`;
    remainingTd.textContent = getRemainingTimeString(rec);
    row.appendChild(remainingTd);

    // Status badge
    const statusTd = document.createElement("td");
    statusTd.id = `status-badge-${rec.id}`;
    statusTd.innerHTML = getStatusBadgeHtml(rec.status, rec.error);
    row.appendChild(statusTd);

    // Control action buttons (Dispatch & Delete)
    const ctrlTd = document.createElement("td");
    ctrlTd.style.textAlign = "center";
    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "4px";
    btnGroup.style.justifyContent = "center";

    const playBtn = document.createElement("button");
    playBtn.className = "btn btn-secondary btn-sm";
    playBtn.style.padding = "4px 8px";
    playBtn.innerHTML = `<i data-lucide="zap" style="width: 12px; height: 12px;"></i>`;
    playBtn.title = "Dispatch Now";
    playBtn.addEventListener("click", () => {
      addLog(`Manual force dispatch triggered for ${rec.name}...`, "system");
      queueDispatch(rec);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.style.padding = "4px 8px";
    delBtn.innerHTML = `<i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>`;
    delBtn.title = "Delete Item";
    delBtn.addEventListener("click", () => {
      deleteRecipient(rec.id);
    });

    btnGroup.appendChild(playBtn);
    btnGroup.appendChild(delBtn);
    ctrlTd.appendChild(btnGroup);
    row.appendChild(ctrlTd);

    tbody.appendChild(row);
  });

  // Checkbox listeners to update selection count
  document.querySelectorAll(".queue-row-checkbox").forEach(cb => {
    cb.addEventListener("change", updateSelectedRowsCount);
  });
  updateSelectedRowsCount();

  lucide.createIcons();
}

// Helper: Update selected row counter
function updateSelectedRowsCount() {
  const selected = document.querySelectorAll(".queue-row-checkbox:checked");
  const counterEl = document.getElementById("selected-rows-count");
  if (counterEl) {
    counterEl.textContent = selected.length;
  }
}

// Batch apply template to selected rows
function applyBatchTemplate() {
  const selectedCbs = document.querySelectorAll(".queue-row-checkbox:checked");
  if (selectedCbs.length === 0) {
    showToast("Please select at least one row in the queue.", "warning");
    return;
  }

  const targetTemplateId = document.getElementById("batch-assign-template-select").value;
  const targetTempObj = state.templates.find(t => t.id === targetTemplateId);
  const targetTempName = targetTempObj ? targetTempObj.name : "Default";

  selectedCbs.forEach(cb => {
    const recId = cb.getAttribute("data-id");
    const rec = state.recipients.find(r => r.id === recId);
    if (rec) {
      rec.templateId = targetTemplateId;
    }
  });

  saveRecipientsToCache();
  renderQueueTable();
  populateTemplateSelector();
  showToast(`Assigned template "${targetTempName}" to ${selectedCbs.length} recipient(s)!`, "success");
  addLog(`Batch assigned template "${targetTempName}" to ${selectedCbs.length} recipient(s).`, "system");
}

// Batch delete selected rows from queue
function deleteSelectedQueueRows() {
  const selectedCbs = document.querySelectorAll(".queue-row-checkbox:checked");
  if (selectedCbs.length === 0) {
    showToast("Please select at least one row to delete.", "warning");
    return;
  }

  if (!confirm(`Are you sure you want to delete ${selectedCbs.length} selected row(s) from the queue?`)) {
    return;
  }

  const selectedIds = Array.from(selectedCbs).map(cb => cb.getAttribute("data-id"));
  state.recipients = state.recipients.filter(r => !selectedIds.includes(r.id));

  saveRecipientsToCache();
  renderQueueTable();
  renderExcelTable();
  updateSummaryStats();
  populateRecipientDropdown();
  populateTemplateSelector();

  showToast(`Deleted ${selectedIds.length} row(s) from queue`, "info");
  addLog(`Batch deleted ${selectedIds.length} recipient(s) from queue.`, "warning");
}

// Calculate remaining countdown string
function getRemainingTimeString(rec) {
  if (rec.status !== "Pending") return "—";
  if (!rec.parsedTime) return "Immediate";

  const diff = rec.parsedTime.getTime() - Date.now();
  if (diff <= 0) return "Due";

  const seconds = Math.floor((diff / 1000) % 60);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const hours = Math.floor((diff / (1000 * 60 * 60)));

  const pad = (num) => String(num).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Helper: Status badge templates
function getStatusBadgeHtml(status, error) {
  if (status === "Sent") {
    if (error && error.includes("Duplicate Protection")) {
      return `<span class="badge badge-indigo" title="Already sent previously. Skipped to prevent duplicate send."><i data-lucide="check-check" style="width:11px; height:11px; margin-right:3px;"></i>Already Sent (Protected)</span>`;
    }
    return `<span class="badge badge-outline-green" title="Dispatched successfully">Sent</span>`;
  }
  if (status === "Sending") {
    return `<span class="badge badge-outline-yellow" title="Currently sending">Sending...</span>`;
  }
  if (status === "Queued") {
    return `<span class="badge badge-outline-gray" title="Waiting for the Gmail send gap">In line</span>`;
  }
  if (status === "Failed") {
    return `<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
              <span class="badge badge-outline-red" style="cursor:help;">Failed</span>
              <span style="font-size: 10px; color: var(--color-rose); max-width: 150px; white-space: normal; word-break: break-word; line-height: 1.2;">${error || 'Unknown Error'}</span>
            </div>`;
  }
  if (status === "Drafted") {
    return `<span class="badge badge-outline-yellow" title="Saved to the Drafts folder">Drafted</span>`;
  }
  return `<span class="badge badge-outline-gray">Pending</span>`;
}

// Update summary metrics cards
function updateSummaryStats() {
  const total = state.recipients.length;
  const valid = state.recipients.filter(r => r.parsedTime !== null).length;
  const invalid = total - valid;

  document.getElementById("parsed-count").textContent = total;
  document.getElementById("stat-valid-count").textContent = valid;
  document.getElementById("stat-invalid-count").textContent = invalid;

  // Queue tab stats
  const pending = state.recipients.filter(r => r.status === "Pending").length;
  const sent = state.recipients.filter(r => r.status === "Sent" || r.status === "Drafted").length;
  const failed = state.recipients.filter(r => r.status === "Failed").length;

  document.getElementById("queue-total-stat").textContent = total;
  document.getElementById("queue-pending-stat").textContent = pending;
  document.getElementById("queue-sent-stat").textContent = sent;
  document.getElementById("queue-failed-stat").textContent = failed;

  // Sidebar badge for active queue
  const sidebarBadge = document.getElementById("queue-badge");
  if (pending > 0) {
    sidebarBadge.textContent = pending;
    sidebarBadge.classList.remove("hidden");
  } else {
    sidebarBadge.classList.add("hidden");
  }

  // Min and Max times
  if (state.recipients.length > 0) {
    const times = state.recipients
      .map(r => r.parsedTime ? r.parsedTime.getTime() : null)
      .filter(t => t !== null);

    if (times.length > 0) {
      const earliest = new Date(Math.min(...times));
      const latest = new Date(Math.max(...times));

      document.getElementById("stat-earliest-time").textContent = earliest.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById("stat-latest-time").textContent = latest.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      document.getElementById("stat-earliest-time").textContent = "Immediate";
      document.getElementById("stat-latest-time").textContent = "Immediate";
    }
  } else {
    document.getElementById("stat-earliest-time").textContent = "—";
    document.getElementById("stat-latest-time").textContent = "—";
  }
}

// Populate Live Preview dropdowns
function populateRecipientDropdown() {
  const select = document.getElementById("preview-recipient-dropdown");
  select.innerHTML = "";

  if (state.recipients.length === 0) {
    select.innerHTML = `<option value="">-- No Recipients Loaded --</option>`;
    return;
  }

  state.recipients.forEach((rec, idx) => {
    const opt = document.createElement("option");
    opt.value = rec.id;
    opt.textContent = `${rec.name} (${rec.affiliation})`;
    if (idx === 0) opt.selected = true;
    select.appendChild(opt);
  });

  updateLivePreview();
}

// Render dynamic variables
function renderTemplate(templateStr, rec) {
  if (!templateStr) return "";
  if (!rec) return templateStr;
  
  console.log("--- renderTemplate Start ---");
  console.log("Original template:", templateStr);
  console.log("Recipient data:", {
    name: rec.name,
    email: rec.email,
    affiliation: rec.affiliation,
    date: rec.date,
    techScheduleName: rec.techScheduleName,
    time: rec.time,
    colValues: rec.colValues
  });
  
  let text = templateStr;
  const replaceTag = (tag, val) => {
    const escapedTag = tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escapedTag, 'gi');
    const oldText = text;
    text = text.replace(regex, val || "");
    if (oldText !== text) {
      console.log(`Replaced '${tag}' with '${val}'`);
    }
  };

  replaceTag("{Name}", rec.name);
  replaceTag("{Affiliation}", rec.affiliation);
  replaceTag("{Date}", rec.date);
  replaceTag("{Technical Schedual Name}", rec.techScheduleName);
  replaceTag("{Technical Schedule Name}", rec.techScheduleName);
  replaceTag("{tsname}", rec.techScheduleName);
  replaceTag("{Session}", rec.techScheduleName);
  replaceTag("{session}", rec.techScheduleName);
  replaceTag("{Time}", rec.time);
  replaceTag("{Email}", rec.email);
  replaceTag("{CC}", rec.cc);
  replaceTag("{BCC}", rec.bcc);

  const resolvedSenderName = rec.senderName || rec.sender || "";
  replaceTag("{Sender Name}", resolvedSenderName);
  replaceTag("{Sender_Name}", resolvedSenderName);
  replaceTag("{SenderName}", resolvedSenderName);
  replaceTag("{Sender}", resolvedSenderName);
  replaceTag("{Action}", rec.action);

  if (rec.colValues) {
    Object.keys(rec.colValues).forEach(colLetter => {
      replaceTag(`{${colLetter}}`, rec.colValues[colLetter]);
    });
  }

  console.log("Rendered text output:", text);
  console.log("--- renderTemplate End ---");
  return text;
}

// Render Live Preview Card
function updateLivePreview() {
  const container = document.getElementById("preview-workspace");
  if (!container) return;
  
  if (state.recipients.length === 0) {
    container.style.flexDirection = "column";
    container.style.flexWrap = "nowrap";
    container.style.justifyContent = "center";
    container.style.alignItems = "center";
    container.style.overflowY = "auto";
    container.innerHTML = `<div class="text-muted" style="font-size: 15px; font-weight: 500;">Please import an Excel file and select a recipient to preview.</div>`;
    return;
  }
  
  const dropdown = document.getElementById("preview-recipient-dropdown");
  const selectedId = dropdown.value;
  const rec = state.recipients.find(r => r.id === selectedId) || state.recipients[0];
  if (!rec) return;

  const showAll = state.previewLayout === "all";
  
  if (showAll) {
    container.style.flexDirection = "row";
    container.style.flexWrap = "wrap";
    container.style.justifyContent = "flex-start";
    container.style.alignItems = "stretch";
    container.style.alignContent = "flex-start";
    container.style.gap = "20px";
    container.style.overflowY = "auto";
    
    container.innerHTML = "";
    state.templates.forEach(t => {
      const subject = renderTemplate(t.subject, rec);
      const body = renderTemplate(t.body, rec);
      
      const accId = rec.senderAccountId || t.senderAccountId;
      const acc = (state.settings.senderAccounts || []).find(a => a.id === accId) || (state.settings.senderAccounts || []).find(a => a.isDefault);
      const displaySenderName = getFinalSenderName(rec, acc);
      const senderStr = acc ? `${escapeHtml(displaySenderName)} &lt;${escapeHtml(acc.user)}&gt;` : `No Sender Account Configured`;
      
      let ccBccHtml = "";
      if (t.cc) {
        ccBccHtml += `<div class="email-meta-line"><span class="meta-label">Cc:</span><span class="meta-val text-teal">${escapeHtml(t.cc)}</span></div>`;
      }
      if (t.bcc) {
        ccBccHtml += `<div class="email-meta-line"><span class="meta-label">Bcc:</span><span class="meta-val text-teal">${escapeHtml(t.bcc)}</span></div>`;
      }
      
      const frame = document.createElement("div");
      frame.className = "email-mockup-frame";
      frame.style.width = "480px";
      frame.style.height = "auto";
      frame.style.maxWidth = "100%";
      frame.style.flexShrink = "0";
      frame.innerHTML = `
        <div class="email-mockup-header">
          <div class="mockup-dot red"></div>
          <div class="mockup-dot yellow"></div>
          <div class="mockup-dot green"></div>
          <div class="mockup-title" style="color: var(--color-indigo); font-weight: 700;">Template: ${escapeHtml(t.name)}</div>
        </div>
        <div class="email-mockup-content">
          <div class="email-meta-line">
            <span class="meta-label">From:</span>
            <span class="meta-val">${senderStr}</span>
          </div>
          <div class="email-meta-line">
            <span class="meta-label">To:</span>
            <span class="meta-val text-teal">${escapeHtml(rec.name)} &lt;${escapeHtml(rec.email)}&gt;</span>
          </div>
          ${ccBccHtml}
          <div class="email-meta-line">
            <span class="meta-label">Subject:</span>
            <span class="meta-val text-bold">${escapeHtml(subject || '(No Subject)')}</span>
          </div>
          <div class="email-meta-line border-bottom">
            <span class="meta-label">Schedule:</span>
            <span class="meta-val text-indigo">${rec.parsedTime ? rec.parsedTime.toLocaleString() : 'Immediate'}</span>
          </div>
          <div class="email-body-pane">
            ${body || '<span class="text-muted">(Empty message)</span>'}
          </div>
        </div>
      `;
      container.appendChild(frame);
    });
  } else {
    container.style.flexDirection = "column";
    container.style.flexWrap = "nowrap";
    container.style.justifyContent = "flex-start";
    container.style.alignItems = "stretch";
    container.style.gap = "0";
    container.style.overflowY = "auto";
    
    const previewTemplateId = document.getElementById("preview-template-dropdown").value || state.activeTemplateId;
    const t = state.templates.find(temp => temp.id === previewTemplateId) || state.templates[0];
    if (!t) return;
    
    const subject = renderTemplate(t.subject, rec);
    const body = renderTemplate(t.body, rec);
    
    const accId = rec.senderAccountId || t.senderAccountId;
    const acc = (state.settings.senderAccounts || []).find(a => a.id === accId) || (state.settings.senderAccounts || []).find(a => a.isDefault);
    const displaySenderName = getFinalSenderName(rec, acc);
    const senderStr = acc ? `${escapeHtml(displaySenderName)} &lt;${escapeHtml(acc.user)}&gt;` : `No Sender Account Configured`;
    
    let ccBccHtml = "";
    if (t.cc) {
      ccBccHtml += `<div class="email-meta-line"><span class="meta-label">Cc:</span><span class="meta-val text-teal">${escapeHtml(t.cc)}</span></div>`;
    }
    if (t.bcc) {
      ccBccHtml += `<div class="email-meta-line"><span class="meta-label">Bcc:</span><span class="meta-val text-teal">${escapeHtml(t.bcc)}</span></div>`;
    }
    
    container.innerHTML = `
      <div class="email-mockup-frame">
        <div class="email-mockup-header">
          <div class="mockup-dot red"></div>
          <div class="mockup-dot yellow"></div>
          <div class="mockup-dot green"></div>
          <div class="mockup-title">Vesper Mail Client View</div>
        </div>
        <div class="email-mockup-content">
          <div class="email-meta-line">
            <span class="meta-label">From:</span>
            <span class="meta-val">${senderStr}</span>
          </div>
          <div class="email-meta-line">
            <span class="meta-label">To:</span>
            <span class="meta-val text-teal">${escapeHtml(rec.name)} &lt;${escapeHtml(rec.email)}&gt;</span>
          </div>
          ${ccBccHtml}
          <div class="email-meta-line">
            <span class="meta-label">Subject:</span>
            <span class="meta-val text-bold">${escapeHtml(subject || '(No Subject)')}</span>
          </div>
          <div class="email-meta-line border-bottom">
            <span class="meta-label">Schedule:</span>
            <span class="meta-val text-indigo">${rec.parsedTime ? rec.parsedTime.toLocaleString() : 'Immediate'}</span>
          </div>
          <div class="email-body-pane">
            ${body || '<span class="text-muted">(Empty message)</span>'}
          </div>
        </div>
      </div>
    `;
  }
}

function populatePreviewTemplateSelector() {
  const select = document.getElementById("preview-template-dropdown");
  if (!select) return;
  select.innerHTML = "";
  
  if (!state.templates || state.templates.length === 0) {
    select.innerHTML = `<option value="">-- No Templates --</option>`;
    return;
  }
  
  state.templates.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    if (t.id === state.activeTemplateId) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

let pollingInterval = null;

function startPollingState() {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      await loadConfigFromServer();
      if (document.getElementById("tab-queue").classList.contains("active")) {
        renderQueueTable();
      }
      updateSummaryStats();
      
      if (state.settings && !state.settings.schedulerActive) {
        state.schedulerActive = false;
        updateSchedulerUIState();
        stopPollingState();
      }
    } catch (e) {
      console.error("Polling error:", e);
    }
  }, 4000);
}

function stopPollingState() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// Start Engine
function startSchedulerEngine() {
  if (state.schedulerActive) return;

  state.schedulerActive = true;
  state.settings.schedulerActive = true;
  saveSettingsToCache();
  updateSchedulerUIState();
  
  const isServerMode = window.location.protocol.startsWith("http");
  if (isServerMode) {
    addLog("Cloud Scheduler Activated. Queue is running in the cloud background 24/7.", "success");
    showToast("Background Scheduler Activated!", "success");
    startPollingState();
  } else {
    addLog("Local Browser Scheduler Activated. Keep tab open to process the queue.", "success");
    showToast("Local Scheduler Activated!", "success");
    processSchedulerStep();
    schedulerInterval = setInterval(processSchedulerStep, 1000);
  }
}

// Stop Engine
function stopSchedulerEngine() {
  if (!state.schedulerActive) return;

  state.schedulerActive = false;
  state.settings.schedulerActive = false;
  saveSettingsToCache();
  updateSchedulerUIState();
  
  const isServerMode = window.location.protocol.startsWith("http");
  if (isServerMode) {
    stopPollingState();
    addLog("Cloud Scheduler Stopped/Cancelled.", "warning");
    showToast("Background Scheduler Stopped", "warning");
  } else {
    if (schedulerInterval) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    addLog("Local Browser Scheduler Stopped.", "warning");
    showToast("Local Scheduler Stopped", "warning");
  }
}

function toggleScheduler() {
  if (state.schedulerActive) {
    stopSchedulerEngine();
  } else {
    startSchedulerEngine();
  }
}

// Sync Sidebar/Deck buttons according to running states
function updateSchedulerUIState() {
  const sidebarBtn = document.getElementById("sidebar-toggle-scheduler");
  const deckStart = document.getElementById("btn-start-scheduler-deck");
  const deckStop = document.getElementById("btn-stop-scheduler-deck");
  const statusIndicator = document.getElementById("scheduler-status-indicator");

  if (state.schedulerActive) {
    // Active UI
    sidebarBtn.innerHTML = `<i data-lucide="square"></i><span>Pause Scheduler</span>`;
    sidebarBtn.className = "btn btn-danger btn-block";
    deckStart.disabled = true;
    deckStop.disabled = false;

    statusIndicator.innerHTML = `
      <span class="status-dot dot-green"></span>
      <span class="status-text">Scheduler Running</span>
    `;
  } else {
    // Inactive UI
    sidebarBtn.innerHTML = `<i data-lucide="play"></i><span>Start Scheduler</span>`;
    sidebarBtn.className = "btn btn-primary btn-block";
    deckStart.disabled = false;
    deckStop.disabled = true;

    statusIndicator.innerHTML = `
      <span class="status-dot dot-gray"></span>
      <span class="status-text">Scheduler Paused</span>
    `;
  }
  lucide.createIcons();
}

// Core execution loop
function processSchedulerStep() {
  if (!state.schedulerActive) return;

  const now = Date.now();
  let queueTableOpen = document.getElementById("tab-queue").classList.contains("active");

  state.recipients.forEach(rec => {
    // Live countdown update in UI if queue tab is open
    if (queueTableOpen) {
      const countdownCell = document.getElementById(`countdown-${rec.id}`);
      if (countdownCell) {
        countdownCell.textContent = getRemainingTimeString(rec);
      }
    }

    if (rec.status === "Pending") {
      // 1. DUPLICATE SENT GUARD
      if (isJobAlreadySent(rec)) {
        rec.status = "Sent";
        rec.error = "Already sent previously (Duplicate Protection Guard)";
        updateRecStatusUI(rec);
        saveRecipientsToCache();
        addLog(`[Sent Guard] Skipped duplicate dispatch to ${rec.name} (${rec.email}). Job already sent previously.`, "info");
        return;
      }

      // 2. STRICT DATE/TIME MATCHING GUARD
      if (!rec.parsedTime) {
        // Missing or unparsed schedule time: DO NOT SEND!
        return;
      }

      const targetTime = rec.parsedTime instanceof Date ? rec.parsedTime.getTime() : new Date(rec.parsedTime).getTime();
      if (isNaN(targetTime)) {
        // Invalid time: DO NOT SEND!
        return;
      }

      if (now >= targetTime) {
        // Date and Time MATCHED! One email at a time, with a Gmail gap.
        queueDispatch(rec);
      }
    }
  });
}

function isInternalAccountLabel(name) {
  const value = String(name || "").trim();
  return /^[A-Za-z0-9.-]+\s*\([^)]+\)$/.test(value) && !value.includes("@");
}

function cleanSenderDisplayName(raw, smtpUser) {
  let name = String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "");
  if (name.includes("<") && name.includes(">")) {
    name = name.split("<")[0].trim().replace(/^["']+|["']+$/g, "");
  }
  if (!name) return "";
  const user = String(smtpUser || "").trim().toLowerCase();
  if (user && name.toLowerCase() === user) return "";
  if (isInternalAccountLabel(name)) return "";
  return name;
}

// Resolve final sender display name from the Excel Sender Name column only.
function getFinalSenderName(rec, acc) {
  const smtpUser = acc && acc.user ? acc.user : "";
  if (rec) {
    const direct = cleanSenderDisplayName(rec.senderName, smtpUser);
    if (direct) return direct;
    for (const key of ["Sender Name", "Sender name", "sender_name", "senderName", "From Name", "FromName", "Display Name", "DisplayName", "Sender Title"]) {
      const candidate = cleanSenderDisplayName(rec[key], smtpUser);
      if (candidate) return candidate;
    }
    if (rec.colValues) {
      for (const [col, val] of Object.entries(rec.colValues)) {
        const header = (state.headers && state.headers[col]) ? String(state.headers[col]).toLowerCase() : "";
        if ((header.includes("sender") || header.includes("from")) && header.includes("name")) {
          const candidate = cleanSenderDisplayName(val, smtpUser);
          if (candidate) return candidate;
        }
      }
    }
    if (rec.sender && String(rec.sender).trim()) {
      const s = String(rec.sender).trim();
      if (s.includes("<") && s.includes(">")) {
        const namePart = cleanSenderDisplayName(s, smtpUser);
        if (namePart) return namePart;
      } else if (!s.includes("@") || s.includes(" ")) {
        const candidate = cleanSenderDisplayName(s, smtpUser);
        if (candidate) return candidate;
      }
    }
  }
  return "";
}

const outboundQueue = [];
let outboundRunning = false;

function queueDispatch(rec) {
  if (!rec || rec.status === "Queued" || rec.status === "Sending" || rec.status === "Sent") return;
  rec.status = "Queued";
  updateRecStatusUI(rec);
  outboundQueue.push(rec);
  drainOutboundQueue();
}

async function drainOutboundQueue() {
  if (outboundRunning) return;
  outboundRunning = true;
  while (outboundQueue.length) {
    const rec = outboundQueue.shift();
    addLog(`Individual email to ${rec.name} (${rec.email}). ${outboundQueue.length} still in line.`, "system");
    await dispatchEmail(rec);
  }
  outboundRunning = false;
}

// Send actual email trigger
async function dispatchEmail(rec) {
  if (isJobAlreadySent(rec) && rec.status !== "Sending") {
    rec.status = "Sent";
    rec.error = "Already sent previously (Duplicate Protection Guard)";
    updateRecStatusUI(rec);
    updateSummaryStats();
    saveRecipientsToCache();
    addLog(`[Sent Guard] Skipped duplicate send to ${rec.name} (${rec.email}).`, "info");
    return;
  }

  rec.status = "Sending";
  updateRecStatusUI(rec);
  updateSummaryStats();

  const templateId = rec.templateId || state.activeTemplateId;
  const jobTemplate = state.templates.find(t => t.id === templateId) || state.templates[0];
  const subject = renderTemplate(jobTemplate.subject, rec);
  const body = renderTemplate(jobTemplate.body, rec);

  const acc = getSenderAccountForJob(rec, jobTemplate);

  if (!acc) {
    failDispatch(rec, "No SMTP sender account configured/matched for this job. Go to Configuration.");
    return;
  }

  const finalSenderName = getFinalSenderName(rec, acc);
  const dispatchAction = getConfiguredAction();
  addLog(`[Local Server] ${dispatchAction === "draft" ? "IMAP draft" : "SMTP send"} for ${rec.name} from "${finalSenderName || acc.user}" <${acc.user}>`, "system");

  return fetch(state.settings.localUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: dispatchAction,
      host: acc.host,
      port: parseInt(acc.port),
      secure: acc.secure,
      user: acc.user,
      pass: acc.pass,
      senderName: finalSenderName,
      senderEmail: acc.user,
      recipientName: rec.name || "",
      recipientEmail: rec.email,
      cc: rec.cc || "",
      bcc: rec.bcc || "",
      subject: subject,
      body: body
    })
  })
  .then(async (response) => {
    const data = await response.json();
    if (response.ok && data.success) {
      rec.action = dispatchAction;
      rec.status = dispatchAction === "draft" ? "Drafted" : "Sent";
      markJobAsSent(rec);
      addLog(dispatchAction === "draft"
        ? `[IMAP] saved draft for ${rec.name} (${rec.email}) from "${finalSenderName}" <${acc.user}>`
        : `[SMTP Server] relayed email to ${rec.name} (${rec.email}) from "${finalSenderName}" <${acc.user}>`, "success");
      updateRecStatusUI(rec);
      updateSummaryStats();
      saveRecipientsToCache();
    } else {
      failDispatch(rec, `Relay Error: ${data.message || 'SMTP Handshake Error'}`);
    }
  })
  .catch((err) => {
    failDispatch(rec, `Relay Connection Failed. Ensure local server script is running. Error: ${err.message}`);
  });
}

// Fail email sending callback
function failDispatch(rec, errMsg) {
  rec.status = "Failed";
  rec.error = errMsg;
  updateRecStatusUI(rec);
  updateSummaryStats();
  saveRecipientsToCache();
  
  addLog(`Failed dispatch to ${rec.name} (${rec.email}): ${errMsg}`, "error");
  showToast(`Failed email to ${rec.name}`, "error");
}

// Sync recipient status indicator row
function updateRecStatusUI(rec) {
  const row = document.getElementById(`row-${rec.id}`);
  if (row) {
    const badgeCell = document.getElementById(`status-badge-${rec.id}`);
    if (badgeCell) {
      badgeCell.innerHTML = getStatusBadgeHtml(rec.status, rec.error);
    }
    const countdownCell = document.getElementById(`countdown-${rec.id}`);
    if (countdownCell) {
      countdownCell.textContent = getRemainingTimeString(rec);
    }
  }
}

// Send Instant Test Email
function sendTestEmail() {
  const testEmail = document.getElementById("global-test-email").value.trim();
  if (!testEmail) {
    showToast("Please enter a valid test recipient email address.", "warning");
    return;
  }

  addLog(`Sending configuration test email to ${testEmail}...`, "system");
  showToast("Sending test email...", "info");

  const testAction = getConfiguredAction();
  const subject = "[Test Vesper] verification email check";
  const body = "This is an instant verification check verifying that your Vesper Mail Scheduler configurations are working correctly.\n\nMode: " + testAction;

  const tmpl = state.templates.find(t => t.id === state.activeTemplateId) || state.template;
  const acc = getSenderAccountForJob(null, tmpl);

  if (!acc) {
    addLog("[Test Email Fail] No SMTP sender account configured or selected.", "error");
    showToast("No Sender Account Configured", "error");
    return;
  }

  const sampleRec = (state.recipients || []).find(r => r.senderName) || (state.recipients && state.recipients.length > 0 ? state.recipients[0] : null);
  const testSenderName = getFinalSenderName(sampleRec, acc);

  fetch(state.settings.localUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: testAction,
      host: acc.host,
      port: parseInt(acc.port),
      secure: acc.secure,
      user: acc.user,
      pass: acc.pass,
      senderName: testSenderName,
      senderEmail: acc.user,
      recipientEmail: testEmail,
      cc: state.template.cc || "",
      bcc: state.template.bcc || "",
      subject: subject,
      body: body
    })
  })
  .then(async (response) => {
    const data = await response.json();
    if (response.ok && data.success) {
      addLog(`[Test ${testAction === "draft" ? "Draft" : "Email"} Success] ${testAction === "draft" ? "Draft saved" : "Sent"} from "${testSenderName}" <${acc.user}>`, "success");
      showToast(testAction === "draft" ? "Test draft saved!" : "Test email sent!", "success");
    } else {
      addLog(`[Test Email Fail] Relay server SMTP/IMAP failure: ${data.message || 'Handshake Failed'}`, "error");
      showToast("Relay action failed", "error");
    }
  })
  .catch(err => {
    addLog(`[Test Email Fail] Connect failure to ${state.settings.localUrl}. Ensure local script is active. Details: ${err.message}`, "error");
    showToast("Server Connection Failed", "error");
  });
}

// Generate sample excel spreadsheet downloader with S_Date and S_Time columns
function downloadSampleExcel() {
  try {
    const fileName = "vesper_multi_account_sample.xlsx";

    // Build workbook dynamically if XLSX library is available
    if (typeof XLSX !== "undefined") {
      const now = new Date();
      const t1 = new Date(now.getTime() + 5 * 60 * 1000);
      const t2 = new Date(now.getTime() + 15 * 60 * 1000);
      const t3 = new Date(now.getTime() + 60 * 60 * 1000);

      const formatDate = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      };

      const formatTimeOnly = (d) => {
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        const sec = String(d.getSeconds()).padStart(2, "0");
        return `${hh}:${min}:${sec}`;
      };

      const sheet1Data = [
        ["Name", "Email", "Affiliation", "Sender Name", "Account Email", "Template", "Date", "Technical Schedual Name", "S_Date", "S_Time", "CC", "BCC", "Action"],
        ["Devin Allen", "devin@example.com", "Acme Corporation", "ISBM Conference Support", "marketing@gmail.com", "Default Template", "2026-07-15", "Routine Maintenance", formatDate(t1), formatTimeOnly(t1), "manager@acme.com", "", "send"],
        ["Elena Rostova", "elena@example.com", "Apex Labs", "Parth Patel", "sales@company.com", "Default Template", "2026-07-16", "Database Upgrade", formatDate(t2), formatTimeOnly(t2), "", "", "draft"]
      ];

      const sheet2Data = [
        ["Name", "Email", "Affiliation", "Sender Name", "Account Email", "Template", "Date", "Technical Schedual Name", "S_Date", "S_Time", "CC", "BCC", "Action"],
        ["Dr. Marcus Vance", "marcus@example.com", "Stanford University", "Executive Team", "marketing@gmail.com", "Executive Follow-up", "2026-07-17", "Server Deployment", formatDate(t3), formatTimeOnly(t3), "admin@stanford.edu", "archive@stanford.edu", "send"],
        ["Sarah Jenkins", "sarah@example.com", "Freelance", "Parth Patel", "sales@company.com", "Executive Follow-up", "2026-07-18", "API Integration", formatDate(now), "04:30 PM", "", "", "draft"]
      ];

      const sheet3Data = [
        ["Label", "Email", "Password", "Host", "Port", "Secure"],
        ["Marketing Gmail", "marketing@gmail.com", "abcd efgh ijkl mnop", "smtp.gmail.com", 465, "ssl"],
        ["Sales Outlook", "sales@company.com", "MyPassword123", "smtp.office365.com", 587, "tls"]
      ];

      const workbook = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
      const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);
      const ws3 = XLSX.utils.aoa_to_sheet(sheet3Data);

      XLSX.utils.book_append_sheet(workbook, ws1, "Campaign A - Standard");
      XLSX.utils.book_append_sheet(workbook, ws2, "Campaign B - Executives");
      XLSX.utils.book_append_sheet(workbook, ws3, "Accounts");

      // Method A: Data URI Download
      try {
        const b64 = XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
        const link = document.createElement("a");
        link.href = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + b64;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast("Downloaded Multi-Account sample Excel file!", "success");
        addLog("Generated and downloaded Multi-Account sample Excel workbook.", "system");
        return;
      } catch (eDataUri) {
        console.warn("Data URI method failed, trying XLSX.writeFile:", eDataUri);
      }

      // Method B: XLSX.writeFile
      try {
        XLSX.writeFile(workbook, fileName);
        showToast("Downloaded Multi-Account sample Excel file!", "success");
        addLog("Generated and downloaded Multi-Account sample Excel workbook.", "system");
        return;
      } catch (eWriteFile) {
        console.warn("XLSX.writeFile failed:", eWriteFile);
      }
    }

    // Method C: Direct HTTP Link to static file
    const link = document.createElement("a");
    link.href = "sample_template.xlsx";
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Downloaded sample Excel file!", "success");

  } catch (err) {
    console.error("Template download error:", err);
    showToast(`Template download failed: ${err.message}`, "error");
    addLog(`Template download error: ${err.message}`, "error");
  }
}

// Generate and Export Campaign Excel Status Report (.xlsx)
function exportCampaignExcelReport(filterStatus = null) {
  if (!state.recipients || state.recipients.length === 0) {
    showToast("No campaign recipient data loaded to export.", "warning");
    return;
  }

  showToast("Preparing Excel Execution Report...", "info");

  let serverOrigin = window.location.protocol.startsWith("http") ? window.location.origin : (state.settings.localUrl ? state.settings.localUrl.replace(/\/send$/, "") : "http://localhost:3000");
  const endpoint = `${serverOrigin}/api/export-report${filterStatus ? '?status=' + filterStatus : ''}`;

  fetch(endpoint)
    .then(async response => {
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Vesper_Mail_Campaign_${filterStatus || 'Full'}_Report.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast("Downloaded Excel report successfully!", "success");
        addLog(`Exported ${filterStatus || 'Master'} Excel Campaign Report via backend server.`, "success");
      } else {
        throw new Error("Backend report endpoint returned non-200");
      }
    })
    .catch(() => {
      // Client-side fallback using XLSX.js
      try {
        if (typeof XLSX === "undefined") {
          showToast("XLSX library not loaded.", "error");
          return;
        }

        let recipientsToExport = state.recipients;
        if (filterStatus) {
          recipientsToExport = state.recipients.filter(r => (r.status || "Pending").toLowerCase() === filterStatus.toLowerCase());
        }

        if (recipientsToExport.length === 0) {
          if (filterStatus && filterStatus.toLowerCase() === "failed") {
            showToast("No failed recipients found in current queue!", "info");
            return;
          }
        }

        const wb = XLSX.utils.book_new();

        if (filterStatus && filterStatus.toLowerCase() === "failed") {
          // Sheet 1: Failed Emails (Re-importable Format)
          const failedHeaders = [
            ["Name", "Email", "Affiliation", "Sender Name", "Account Email", "Template", "S_Date", "S_Time", "CC", "BCC", "Action", "Status", "Error Details", "Recommended Action"]
          ];
          recipientsToExport.forEach(r => {
            const err = r.error || "";
            const actionRec = err.includes("Relay Connection") ? "Keep python server.py window open" : (err.includes("550") ? "Switch sender account or wait 24h" : "Check 16-digit Google App Password");
            failedHeaders.push([
              r.name || "",
              r.email || "",
              r.affiliation || "",
              r.senderName || "",
              r.sender || "",
              r.templateId || "",
              r.rawSDate || r.date || "",
              r.rawSTime || r.time || "",
              r.cc || "",
              r.bcc || "",
              r.action || "send",
              r.status || "Failed",
              err,
              actionRec
            ]);
          });
          const ws1 = XLSX.utils.aoa_to_sheet(failedHeaders);
          XLSX.utils.book_append_sheet(wb, ws1, "Failed Emails (Re-importable)");

          // Sheet 2: All Campaign Jobs
          const masterHeaders = [
            ["Sr. No", "Name", "Email", "CC", "BCC", "Sender Account", "Template ID", "Status", "Dispatched At", "Error Details"]
          ];
          state.recipients.forEach((r, idx) => {
            masterHeaders.push([
              idx + 1, r.name || "", r.email || "", r.cc || "", r.bcc || "",
              r.sender || "", r.templateId || "", r.status || "Pending",
              r.dispatchedAt || "", r.error || ""
            ]);
          });
          const ws2 = XLSX.utils.aoa_to_sheet(masterHeaders);
          XLSX.utils.book_append_sheet(wb, ws2, "All Campaign Jobs");
        } else {
          // Master Report
          const masterHeaders = [
            ["Sr. No", "Name", "Email", "CC", "BCC", "Sender Account", "Template ID", "Scheduled Time", "Status", "Dispatched At", "Error Details"]
          ];
          recipientsToExport.forEach((r, idx) => {
            masterHeaders.push([
              idx + 1, r.name || "", r.email || "", r.cc || "", r.bcc || "",
              r.sender || "", r.templateId || "", r.parsedTime ? new Date(r.parsedTime).toLocaleString() : (r.time || ""),
              r.status || "Pending", r.dispatchedAt || "", r.error || ""
            ]);
          });
          const ws1 = XLSX.utils.aoa_to_sheet(masterHeaders);
          XLSX.utils.book_append_sheet(wb, ws1, "Master Campaign Status");

          const failedJobs = state.recipients.filter(r => r.status === "Failed");
          if (failedJobs.length > 0) {
            const failedHeaders = [
              ["Name", "Email", "Affiliation", "Sender Name", "Account Email", "Template", "Status", "Error Details", "Recommended Action"]
            ];
            failedJobs.forEach(r => {
              const err = r.error || "";
              const actionRec = err.includes("Relay Connection") ? "Keep python server.py window open" : (err.includes("550") ? "Switch sender account or wait 24h" : "Check 16-digit Google App Password");
              failedHeaders.push([
                r.name || "", r.email || "", r.affiliation || "", r.senderName || "",
                r.sender || "", r.templateId || "", "Failed", err, actionRec
              ]);
            });
            const ws2 = XLSX.utils.aoa_to_sheet(failedHeaders);
            XLSX.utils.book_append_sheet(wb, ws2, "Failed Emails Only");
          }
        }

        const fileName = `Vesper_Mail_Campaign_${filterStatus || 'Full'}_Report.xlsx`;
        XLSX.writeFile(wb, fileName);
        showToast("Downloaded Excel Execution Report!", "success");
        addLog(`Generated and downloaded ${fileName}.`, "system");
      } catch (err) {
        showToast(`Failed to generate report: ${err.message}`, "error");
      }
    });
}

// Basic HTML escaping
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Test connection to the local SMTP helper server
function testLocalServerConnection() {
  const badge = document.getElementById("local-server-status-badge");
  if (!badge) return;

  const urlInput = document.getElementById("local-server-url").value.trim();
  if (!urlInput) {
    badge.className = "connection-status-badge status-disconnected";
    badge.textContent = "Status: URL is empty";
    return;
  }

  badge.className = "connection-status-badge status-unknown";
  badge.textContent = "Status: Connecting...";

  // Convert send endpoint to health endpoint
  const healthUrl = urlInput.replace(/\/send\/?$/, "/health");

  // Fetch with a short timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  fetch(healthUrl, { signal: controller.signal })
    .then(response => response.json())
    .then(data => {
      clearTimeout(timeoutId);
      if (data && data.status === "healthy") {
        badge.className = "connection-status-badge status-connected";
        badge.textContent = "Status: Connected (Server Active)";
        showToast("Connected to helper server successfully!", "success");
      } else {
        throw new Error("Invalid response format");
      }
    })
    .catch(err => {
      clearTimeout(timeoutId);
      badge.className = "connection-status-badge status-unknown";
      badge.textContent = "Status: Scanning local ports...";
      scanLocalPorts();
    });
}

// Scan ports 3000 to 3010 to find where our server is running
function scanLocalPorts() {
  const badge = document.getElementById("local-server-status-badge");
  const portsToScan = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];
  let found = false;
  let completedScans = 0;

  portsToScan.forEach(port => {
    const healthUrl = `http://localhost:${port}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);

    fetch(healthUrl, { signal: controller.signal })
      .then(response => response.json())
      .then(data => {
        clearTimeout(timeoutId);
        if (data && data.status === "healthy" && !found) {
          found = true;
          const suggestedUrl = `http://localhost:${port}/send`;
          const inputEl = document.getElementById("local-server-url");
          if (inputEl) inputEl.value = suggestedUrl;
          state.settings.localUrl = suggestedUrl;
          saveSettingsToCache();
          badge.className = "connection-status-badge status-connected";
          badge.textContent = `Status: Connected (Server Active on port ${port})`;
          badge.setAttribute("data-suggested-url", suggestedUrl);
          showToast(`Connected to helper server on port ${port}!`, "success");
        }
      })
      .catch(() => {
        clearTimeout(timeoutId);
      })
      .finally(() => {
        completedScans++;
        if (completedScans === portsToScan.length && !found) {
          badge.className = "connection-status-badge status-disconnected";
          badge.textContent = "Status: Disconnected (Is server running?)";
          showToast("Helper server not detected. Make sure server.py or server.js is running.", "error");
        }
      });
  });
}

// Helper: format Date object for datetime-local input value
function formatDateTimeLocal(date) {
  if (!date) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

// Render Sender Accounts Table in Configuration Tab
function renderSenderAccountsTable() {
  const tbody = document.getElementById("sender-accounts-table").querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!state.settings.senderAccounts || state.settings.senderAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted" style="padding: 20px; font-size: 13px; text-align: center;">No sender accounts configured yet. Add one below.</td>
      </tr>
    `;
    return;
  }

  state.settings.senderAccounts.forEach(acc => {
    const row = document.createElement("tr");
    
    const defaultIcon = acc.isDefault 
      ? `<span class="badge badge-indigo"><i data-lucide="check" style="width: 12px; height: 12px; margin-right: 4px;"></i> Default</span>`
      : `<button class="btn btn-secondary btn-sm btn-set-default-acc" data-id="${acc.id}" style="padding: 4px 8px; font-size: 11px;">Set Default</button>`;

    row.innerHTML = `
      <td style="padding: 10px 12px; font-size: 13px; font-weight: 600;">${escapeHtml(acc.label)}</td>
      <td style="padding: 10px 12px; font-size: 13px; color: var(--text-secondary);">${escapeHtml(acc.user)}</td>
      <td style="padding: 10px 12px; font-size: 13px; font-family: var(--font-mono); color: var(--text-muted);">${escapeHtml(acc.host)}:${acc.port}</td>
      <td style="padding: 10px 12px; font-size: 13px;">${defaultIcon}</td>
      <td style="padding: 10px 12px; font-size: 13px; text-align: center;">
        <div style="display: flex; gap: 6px; justify-content: center;">
          <button class="btn btn-indigo btn-sm btn-test-acc" data-id="${acc.id}" title="Test Connection" style="padding: 4px 8px; font-size: 11px;"><i data-lucide="refresh-cw" style="width: 13px; height: 13px;"></i></button>
          <button class="btn btn-danger btn-sm btn-delete-acc" data-id="${acc.id}" title="Delete" style="padding: 4px 8px; font-size: 11px;"><i data-lucide="trash-2" style="width: 13px; height: 13px;"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });

  // Re-bind click events
  document.querySelectorAll(".btn-set-default-acc").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      setSenderAccountAsDefault(id);
    });
  });

  document.querySelectorAll(".btn-test-acc").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      testSenderAccountConnection(id);
    });
  });

  document.querySelectorAll(".btn-delete-acc").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      deleteSenderAccount(id);
    });
  });

  lucide.createIcons();
}

// Set Account as Default
function setSenderAccountAsDefault(id) {
  state.settings.senderAccounts.forEach(acc => {
    acc.isDefault = (acc.id === id);
  });
  saveSettingsToCache();
  renderSenderAccountsTable();
  populateSenderDropdowns();
  renderQueueTable(); // updates queue lists
  showToast("Default sender account updated", "success");
}

// Delete Sender Account
function deleteSenderAccount(id) {
  state.settings.senderAccounts = state.settings.senderAccounts.filter(acc => acc.id !== id);
  
  // If we deleted default, set another one as default
  if (state.settings.senderAccounts.length > 0) {
    const hasDefault = state.settings.senderAccounts.some(acc => acc.isDefault);
    if (!hasDefault) {
      state.settings.senderAccounts[0].isDefault = true;
    }
  }

  saveSettingsToCache();
  renderSenderAccountsTable();
  populateSenderDropdowns();
  renderQueueTable();
  showToast("Sender account removed", "info");
}

// Populate Sender Dropdowns in Compose tab and Table edits
function populateSenderDropdowns() {
  const dropdown = document.getElementById("email-sender-template");
  if (!dropdown) return;
  dropdown.innerHTML = "";

  if (!state.settings.senderAccounts || state.settings.senderAccounts.length === 0) {
    dropdown.innerHTML = `<option value="">-- No Accounts Configured --</option>`;
    updateComposeReadOnlyConfig();
    return;
  }

  state.settings.senderAccounts.forEach(acc => {
    const opt = document.createElement("option");
    opt.value = acc.id;
    opt.textContent = `${acc.label} (${acc.user})`;
    if (acc.isDefault) {
      opt.selected = true;
      if (!state.template.senderAccountId) {
        state.template.senderAccountId = acc.id;
      }
    }
    dropdown.appendChild(opt);
  });

  if (state.template.senderAccountId) {
    dropdown.value = state.template.senderAccountId;
  }
  
  updateComposeReadOnlyConfig();
}

function updateComposeReadOnlyConfig() {
  const senderEl = document.getElementById("email-sender-template-read-only");
  const actionEl = document.getElementById("email-action-template-read-only");
  
  if (senderEl) {
    const activeAcc = (state.settings.senderAccounts || []).find(a => a.isDefault);
    senderEl.textContent = activeAcc 
      ? `${activeAcc.label} <${activeAcc.user}>` 
      : "-- No Accounts Configured (Go to Configuration) --";
  }
  
  if (actionEl) {
    const isDraft = getConfiguredAction() === "draft";
    actionEl.textContent = isDraft ? "IMAP Drafts" : "SMTP Send";
    actionEl.title = "Change Send or Draft on the Configuration page";
  }
  const actionSelect = document.getElementById("email-action-template");
  if (actionSelect) actionSelect.value = getConfiguredAction();
}

// Test Connection for Specific Account
function testSenderAccountConnection(id) {
  const acc = state.settings.senderAccounts.find(a => a.id === id);
  if (!acc) return;

  // Sanitize host and password dynamically
  acc.host = sanitizeSmtpHost(acc.host) || autoDetectSmtpSettings(acc.user).host;
  acc.pass = sanitizePassword(acc.pass, acc.host, acc.user);
  saveSettingsToCache();

  showToast(`Testing connection for ${acc.label}...`, "info");
  addLog(`[Local Server] Testing SMTP connection for account ${acc.label} (${acc.user}) via ${acc.host}:${acc.port} (${acc.secure.toUpperCase()})...`, "system");

  const baseUrl = state.settings.localUrl.replace(/\/send$/, '');
  const testApiUrl = `${baseUrl}/api/test-connection`;

  fetch(testApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      host: acc.host,
      port: parseInt(acc.port),
      secure: acc.secure,
      user: acc.user,
      pass: acc.pass
    })
  })
  .then(async (response) => {
    const data = await response.json();
    if (response.ok && data.success) {
      showToast(`Account ${acc.label} connected successfully!`, "success");
      addLog(`[Test Success] Account ${acc.label} (${acc.user}) authenticated cleanly!`, "success");
    } else {
      showToast(`Connection failed: ${data.message || 'SMTP Handshake Error'}`, "error");
      addLog(`[Test Fail] Account ${acc.label} (${acc.user}) error: ${data.message}`, "error");
    }
  })
  .catch(err => {
    showToast(`Relay Connection Failed. Ensure server script (python server.py) is active.`, "error");
    addLog(`[Test Fail] Connection to local relay server failed: ${err.message}`, "error");
  });
}

// -------------------------------------------------------------
// GMAIL-STYLE COMPOSER HELPER FUNCTIONS
// -------------------------------------------------------------

// Insert text or tags at current cursor position inside contenteditable
function insertTextAtCursor(text) {
  const sel = window.getSelection();
  const editor = document.getElementById("email-body-editor");
  if (!editor) return;

  if (sel.getRangeAt && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    // Check if selection is actually inside the editor
    if (editor.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      
      // Move caret after the inserted text
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }
  
  // Fallback: If not focused or cursor not in editor, append to body
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Convert HTML rich content back to clean plain text for mailto/web links
function htmlToPlainText(html) {
  if (!html) return "";
  
  // Replace <br> tags with linebreaks
  let text = html.replace(/<br\s*\/?>/gi, "\n");
  
  // Handle list items
  text = text.replace(/<li[^>]*>/gi, " • ").replace(/<\/li>/gi, "\n");
  
  // Replace block closures with newlines
  text = text.replace(/<\/div>/gi, "\n").replace(/<div>/gi, "");
  text = text.replace(/<\/p>/gi, "\n").replace(/<p>/gi, "");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  
  // Strip all HTML tags
  text = text.replace(/<[^>]*>/g, "");
  
  // Decode HTML entities
  const tempDoc = new DOMParser().parseFromString(text, "text/html");
  return tempDoc.body.textContent || tempDoc.body.innerText || text;
}



// Dynamic Column Mapping Helpers
function updateTableHeadersWithLetters(mappings) {
  const table = document.getElementById("excel-preview-table");
  if (!table) return;
  const headers = table.querySelectorAll("thead th");
  if (headers.length < 12) return;

  const paint = (index, label, col, badgeClass) => {
    if (!headers[index]) return;
    headers[index].innerHTML = `${label}${col ? ` <span class="badge ${badgeClass}" style="margin-left:5px;">Col ${col}</span>` : ""}`;
  };

  paint(2, "Name", mappings.name, "badge-indigo");
  paint(3, "Email", mappings.email, "badge-indigo");
  paint(4, "Affiliation", mappings.aff, "badge-outline-gray");
  paint(8, "Date", mappings.date, "badge-outline-gray");
  paint(9, "Session / Tech Schedule", mappings.session, "badge-outline-yellow");
  paint(11, "S_Time (Raw)", mappings.time, "badge-outline-gray");
}

function updateMergeTagsMenu(columnKeys, headerRow) {
  const menu = document.getElementById("gmail-merge-tags-menu");
  if (!menu) return;
  
  if (!menu.dataset.originalHtml) {
    menu.dataset.originalHtml = menu.innerHTML;
  }
  
  let newHtml = menu.dataset.originalHtml;
  newHtml += `<div class="merge-tag-divider" style="height: 1px; background: var(--border-color); margin: 6px 0;"></div>`;
  newHtml += `<div style="padding: 6px 12px; font-size: 10px; font-weight: bold; color: var(--text-muted); text-transform: uppercase;">Excel Columns</div>`;
  
  columnKeys.forEach(col => {
    const colName = headerRow[col] ? String(headerRow[col]).trim() : `Column ${col}`;
    newHtml += `
      <div class="merge-tag-item" data-tag="{${col}}">
        <i data-lucide="table" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 6px;"></i>
        Col {${col}} - ${escapeHtml(colName)}
      </div>
    `;
  });
  
  menu.innerHTML = newHtml;
  
  // Re-bind click handlers
  const bodyEditor = document.getElementById("email-body-editor");
  document.querySelectorAll(".merge-tag-item").forEach(item => {
    const newItem = item.cloneNode(true);
    item.replaceWith(newItem);
    
    newItem.addEventListener("click", () => {
      const tag = newItem.getAttribute("data-tag");
      if (bodyEditor) {
        bodyEditor.focus();
        insertTextAtCursor(tag);
        state.template.body = bodyEditor.innerHTML;
        saveTemplateToCache();
        updateLivePreview();
      }
    });
  });
  
  lucide.createIcons();
}

// -------------------------------------------------------------
// TEMPLATE MANAGEMENT FUNCTIONS
// -------------------------------------------------------------

function populateTemplateSelector() {
  const select = document.getElementById("composer-template-selector");
  if (!select) return;
  select.innerHTML = "";
  
  if (!state.templates) {
    state.templates = [];
  }
  
  state.templates.forEach(t => {
    const count = state.recipients ? state.recipients.filter(r => (r.templateId || state.activeTemplateId) === t.id).length : 0;
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.name} (${count} recipient${count === 1 ? '' : 's'})`;
    if (t.id === state.activeTemplateId) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

function handleTemplateChange(templateId) {
  const t = state.templates.find(temp => temp.id === templateId);
  if (!t) return;
  
  state.activeTemplateId = templateId;
  state.template = t; // Update the reference so existing event handlers modify the correct template!
  
  // Save active template id to cache
  localStorage.setItem("vesper_active_template_id", templateId);
  
  // Update fields in compose editor
  document.getElementById("email-subject-template").value = t.subject || "";
  document.getElementById("email-cc-template").value = t.cc || "";
  document.getElementById("email-bcc-template").value = t.bcc || "";
  
  let bodyHtml = t.body || "";
  if (bodyHtml && !bodyHtml.includes("<") && !bodyHtml.includes(">")) {
    bodyHtml = bodyHtml.replace(/\n/g, "<br>");
  }
  const bodyEditor = document.getElementById("email-body-editor");
  if (bodyEditor) {
    bodyEditor.innerHTML = bodyHtml;
  }
  
  // CC / BCC visibility sync
  const rowCc = document.getElementById("cc-field-row");
  const rowBcc = document.getElementById("bcc-field-row");
  if (rowCc) {
    if (t.cc) rowCc.classList.remove("hidden");
    else rowCc.classList.add("hidden");
  }
  if (rowBcc) {
    if (t.bcc) rowBcc.classList.remove("hidden");
    else rowBcc.classList.add("hidden");
  }
  
  // Word docx banner sync
  const banner = document.getElementById("docx-loaded-banner");
  const bannerFilename = document.getElementById("docx-banner-filename");
  if (banner && bannerFilename) {
    if (t.docxSource) {
      bannerFilename.textContent = `Template imported from: ${t.docxSource}`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  updateComposeReadOnlyConfig();
  updateLivePreview();
}

function readComposerFieldsIntoTemplate(target) {
  const subjectInput = document.getElementById("email-subject-template");
  const ccInput = document.getElementById("email-cc-template");
  const bccInput = document.getElementById("email-bcc-template");
  const bodyEditor = document.getElementById("email-body-editor");
  if (!target) return;
  if (subjectInput) target.subject = subjectInput.value;
  if (ccInput) target.cc = ccInput.value;
  if (bccInput) target.bcc = bccInput.value;
  if (bodyEditor) target.body = bodyEditor.innerHTML;
}

function saveCurrentComposerAsNamedTemplate() {
  if (!state.template) return;
  readComposerFieldsIntoTemplate(state.template);

  const currentName = state.template.name || "Untitled";
  const entered = prompt("Save this template as (use a different name to keep a separate copy):", currentName);
  if (entered === null) return;
  const trimmed = entered.trim();
  if (!trimmed) {
    showToast("Template name cannot be empty.", "warning");
    return;
  }

  const duplicate = (state.templates || []).find(t => t.id !== state.template.id && t.name.toLowerCase() === trimmed.toLowerCase());
  if (duplicate) {
    if (!confirm(`A template named "${duplicate.name}" already exists. Replace that template with the current composer?`)) {
      return;
    }
    duplicate.subject = state.template.subject || "";
    duplicate.cc = state.template.cc || "";
    duplicate.bcc = state.template.bcc || "";
    duplicate.body = state.template.body || "";
    duplicate.docxSource = state.template.docxSource;
    populateTemplateSelector();
    populatePreviewTemplateSelector();
    handleTemplateChange(duplicate.id);
    saveTemplateToCache();
    showToast(`Saved template "${duplicate.name}"`, "success");
    renderQueueTable();
    return;
  }

  if (trimmed.toLowerCase() !== currentName.toLowerCase()) {
    const id = `template-${Date.now()}`;
    const copy = {
      id: id,
      name: trimmed,
      subject: state.template.subject || "",
      cc: state.template.cc || "",
      bcc: state.template.bcc || "",
      body: state.template.body || "",
      senderAccountId: state.template.senderAccountId || "",
      action: getConfiguredAction(),
      docxSource: state.template.docxSource
    };
    state.templates.push(copy);
    populateTemplateSelector();
    populatePreviewTemplateSelector();
    handleTemplateChange(id);
    saveTemplateToCache();
    showToast(`Saved new template "${trimmed}"`, "success");
    renderQueueTable();
    return;
  }

  state.template.name = trimmed;
  saveTemplateToCache();
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  const statusEl = document.getElementById("gmail-save-status");
  if (statusEl) statusEl.textContent = `Saved "${trimmed}"`;
  showToast(`Saved template "${trimmed}"`, "success");
  renderQueueTable();
}

function createNewTemplate() {
  const name = prompt("Enter a name for the new template:", "New Template");
  if (!name || !name.trim()) return;
  const trimmed = name.trim();

  if ((state.templates || []).some(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
    showToast(`A template named "${trimmed}" already exists. Choose another name.`, "warning");
    return;
  }
  
  const id = `template-${Date.now()}`;
  const newT = {
    id: id,
    name: trimmed,
    subject: "",
    cc: "",
    bcc: "",
    body: "",
    senderAccountId: "",
    action: getConfiguredAction()
  };
  
  state.templates.push(newT);
  
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  handleTemplateChange(id);
  saveTemplateToCache();
  showToast(`Created empty template: ${trimmed}`, "success");
  
  // Refresh queue details and dropdown lists
  renderQueueTable();
}

function renameTemplate() {
  const t = state.templates.find(temp => temp.id === state.activeTemplateId);
  if (!t) return;
  
  const newName = prompt(`Rename template "${t.name}" to:`, t.name);
  if (!newName || !newName.trim()) return;
  const trimmed = newName.trim();
  if ((state.templates || []).some(temp => temp.id !== t.id && temp.name.toLowerCase() === trimmed.toLowerCase())) {
    showToast(`A template named "${trimmed}" already exists.`, "warning");
    return;
  }
  
  t.name = trimmed;
  saveTemplateToCache();
  
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  showToast(`Renamed template to: ${t.name}`, "success");
  
  // Refresh queue details and dropdown lists
  renderQueueTable();
}

function deleteTemplate() {
  if (state.templates.length <= 1) {
    showToast("You must keep at least one template.", "warning");
    return;
  }
  
  const t = state.templates.find(temp => temp.id === state.activeTemplateId);
  if (!t) return;
  
  if (!confirm(`Are you sure you want to delete template "${t.name}"?`)) {
    return;
  }
  
  const deletedIndex = state.templates.findIndex(temp => temp.id === state.activeTemplateId);
  state.templates = state.templates.filter(temp => temp.id !== state.activeTemplateId);
  saveTemplateToCache();
  
  // Switch to the first template
  const newActiveId = state.templates[0].id;
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  handleTemplateChange(newActiveId);
  
  showToast(`Deleted template: ${t.name}`, "info");
  
  // Refresh queue details and dropdown lists
  renderQueueTable();
}

// Helper for XML DOM node lookup across namespaces
function getXmlChild(parent, localName) {
  if (!parent) return null;
  for (const child of Array.from(parent.children || parent.childNodes)) {
    if (child.nodeType === 1) {
      const name = child.localName || child.tagName.replace(/^w:/, "");
      if (name === localName) return child;
    }
  }
  return null;
}

function getXmlChildren(parent, localName) {
  if (!parent) return [];
  const result = [];
  for (const child of Array.from(parent.children || parent.childNodes)) {
    if (child.nodeType === 1) {
      const name = child.localName || child.tagName.replace(/^w:/, "");
      if (name === localName) result.push(child);
    }
  }
  return result;
}

// Trim leading empty paragraphs and blank lines from top of email HTML
function trimLeadingEmptyElements(html) {
  if (!html) return "";
  const temp = document.createElement("div");
  temp.innerHTML = html;

  while (temp.firstChild) {
    const fc = temp.firstChild;
    if (fc.nodeType === 3 && !fc.textContent.trim()) {
      temp.removeChild(fc);
    } else if (fc.nodeType === 1 && (fc.tagName.toLowerCase() === "p" || fc.tagName.toLowerCase() === "div")) {
      const text = fc.textContent.replace(/\u00a0|&nbsp;/g, "").trim();
      const imgs = fc.querySelectorAll("img");
      if (!text && imgs.length === 0) {
        temp.removeChild(fc);
      } else {
        break;
      }
    } else if (fc.nodeType === 1 && fc.tagName.toLowerCase() === "br") {
      temp.removeChild(fc);
    } else {
      break;
    }
  }

  // Remove top margin/padding from the first content element to eliminate top blank space
  if (temp.firstElementChild) {
    temp.firstElementChild.style.marginTop = "0px";
    temp.firstElementChild.style.paddingTop = "0px";
  }

  return temp.innerHTML;
}

// High-Fidelity Word (.docx) XML to HTML Parser with Full Format, RGB Colors, Spacing & Alignment
async function parseDocxToFullHtml(arrayBuffer) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip not available");
  }

  const zip = await JSZip.loadAsync(arrayBuffer);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Invalid .docx file: word/document.xml missing");
  }

  const docXmlText = await docXmlFile.async("string");
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXmlText, "application/xml");

  // 1. Load styles from word/styles.xml
  const stylesMap = {};
  const stylesFile = zip.file("word/styles.xml");
  if (stylesFile) {
    try {
      const stylesXmlText = await stylesFile.async("string");
      const stylesDoc = parser.parseFromString(stylesXmlText, "application/xml");
      const styleNodes = stylesDoc.querySelectorAll("style");
      for (const st of Array.from(styleNodes)) {
        const styleId = st.getAttribute("w:styleId");
        if (!styleId) continue;
        stylesMap[styleId] = {
          pPr: getXmlChild(st, "pPr"),
          rPr: getXmlChild(st, "rPr")
        };
      }
    } catch (e) {
      console.warn("Could not parse word/styles.xml:", e);
    }
  }

  // 2. Load numbering from word/numbering.xml
  const numMap = {};
  const numberingFile = zip.file("word/numbering.xml");
  if (numberingFile) {
    try {
      const numXmlText = await numberingFile.async("string");
      const numDoc = parser.parseFromString(numXmlText, "application/xml");
      const numNodes = numDoc.querySelectorAll("num");
      for (const n of Array.from(numNodes)) {
        const numId = n.getAttribute("w:numId");
        const abstractNumIdEl = getXmlChild(n, "abstractNumId");
        if (numId && abstractNumIdEl) {
          numMap[numId] = abstractNumIdEl.getAttribute("w:val");
        }
      }
    } catch (e) {
      console.warn("Could not parse word/numbering.xml:", e);
    }
  }
  const listCounters = {};

  // 3. Load images/media map from relationships
  const relsFile = zip.file("word/_rels/document.xml.rels");
  const mediaMap = {};
  if (relsFile) {
    const relsXmlText = await relsFile.async("string");
    const relsDoc = parser.parseFromString(relsXmlText, "application/xml");
    const relElements = relsDoc.querySelectorAll("Relationship");
    for (const rel of Array.from(relElements)) {
      const rId = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (rId && target && target.includes("media/")) {
        const mediaPath = target.startsWith("word/") ? target : "word/" + target.replace(/^\//, "");
        const imgFile = zip.file(mediaPath);
        if (imgFile) {
          const base64 = await imgFile.async("base64");
          const ext = mediaPath.split(".").pop().toLowerCase();
          let mime = "image/png";
          if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "gif") mime = "image/gif";
          else if (ext === "svg") mime = "image/svg+xml";
          mediaMap[rId] = `data:${mime};base64,${base64}`;
        }
      }
    }
  }

  const highlightMap = {
    yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff",
    blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080",
    darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
    darkYellow: "#808000", darkGray: "#808080", lightGray: "#d3d3d3", black: "#000000"
  };

  function resolveColorValue(val) {
    if (!val || val === "auto" || val === "none") return null;
    if (typeof parseCssColor === "function") {
      const p = parseCssColor(val);
      if (p) return p.css;
    }
    if (highlightMap[val]) return highlightMap[val];
    return val.startsWith("#") ? val : "#" + val;
  }

  function getRunStyles(rPr, styleId) {
    const inheritedPr = styleId && stylesMap[styleId] ? stylesMap[styleId].rPr : null;
    const styles = [];

    // Text color (w:color)
    const colorEl = getXmlChild(rPr, "color") || getXmlChild(inheritedPr, "color");
    if (colorEl) {
      const val = colorEl.getAttribute("w:val");
      const c = resolveColorValue(val);
      if (c) styles.push(`color: ${c}`);
    }

    // Highlight / Shading background color (w:highlight / w:shd)
    const highlightEl = getXmlChild(rPr, "highlight") || getXmlChild(inheritedPr, "highlight");
    if (highlightEl) {
      const val = highlightEl.getAttribute("w:val");
      const bg = resolveColorValue(val);
      if (bg) styles.push(`background-color: ${bg}`);
    } else {
      const shdEl = getXmlChild(rPr, "shd") || getXmlChild(inheritedPr, "shd");
      if (shdEl) {
        const fill = shdEl.getAttribute("w:fill");
        const bg = resolveColorValue(fill);
        if (bg) styles.push(`background-color: ${bg}`);
      }
    }

    // Font size (w:sz in half-points)
    const szEl = getXmlChild(rPr, "sz") || getXmlChild(inheritedPr, "sz");
    if (szEl) {
      const val = parseInt(szEl.getAttribute("w:val"), 10);
      if (!isNaN(val)) {
        const pt = (val / 2).toFixed(1).replace(/\.0$/, "");
        styles.push(`font-size: ${pt}pt`);
      }
    }

    // Font Family (w:rFonts)
    const fontEl = getXmlChild(rPr, "rFonts") || getXmlChild(inheritedPr, "rFonts");
    if (fontEl) {
      const ascii = fontEl.getAttribute("w:ascii") || fontEl.getAttribute("w:hAnsi") || fontEl.getAttribute("w:cs");
      if (ascii) {
        styles.push(`font-family: '${ascii}', sans-serif`);
      }
    }

    // Bold, Italic, Underline, Strikethrough
    const bEl = getXmlChild(rPr, "b") || getXmlChild(inheritedPr, "b");
    if (bEl && bEl.getAttribute("w:val") !== "false" && bEl.getAttribute("w:val") !== "0") {
      styles.push("font-weight: bold");
    }
    const iEl = getXmlChild(rPr, "i") || getXmlChild(inheritedPr, "i");
    if (iEl && iEl.getAttribute("w:val") !== "false" && iEl.getAttribute("w:val") !== "0") {
      styles.push("font-style: italic");
    }
    const uEl = getXmlChild(rPr, "u") || getXmlChild(inheritedPr, "u");
    if (uEl && uEl.getAttribute("w:val") !== "none") {
      styles.push("text-decoration: underline");
    }
    const strikeEl = getXmlChild(rPr, "strike") || getXmlChild(inheritedPr, "strike");
    if (strikeEl && strikeEl.getAttribute("w:val") !== "false" && strikeEl.getAttribute("w:val") !== "0") {
      styles.push("text-decoration: line-through");
    }

    return styles;
  }

  function getParagraphProperties(pPr, styleId) {
    const inheritedPr = styleId && stylesMap[styleId] ? stylesMap[styleId].pPr : null;
    const styles = [];

    // Alignment (w:jc)
    const jcEl = getXmlChild(pPr, "jc") || getXmlChild(inheritedPr, "jc");
    if (jcEl) {
      const val = jcEl.getAttribute("w:val");
      if (val === "center") styles.push("text-align: center");
      else if (val === "right") styles.push("text-align: right");
      else if (val === "both" || val === "justify") styles.push("text-align: justify");
      else if (val === "left") styles.push("text-align: left");
    }

    // Spacing (w:spacing in twips: 20 twips = 1pt)
    const spacingEl = getXmlChild(pPr, "spacing") || getXmlChild(inheritedPr, "spacing");
    if (spacingEl) {
      const before = spacingEl.getAttribute("w:before");
      const after = spacingEl.getAttribute("w:after");
      const line = spacingEl.getAttribute("w:line");

      if (before) {
        const pt = (parseInt(before, 10) / 20).toFixed(1).replace(/\.0$/, "");
        styles.push(`margin-top: ${pt}pt`);
      }
      if (after) {
        const pt = (parseInt(after, 10) / 20).toFixed(1).replace(/\.0$/, "");
        styles.push(`margin-bottom: ${pt}pt`);
      }
      if (line) {
        const lineVal = parseInt(line, 10);
        if (!isNaN(lineVal)) {
          const lh = (lineVal / 240).toFixed(2).replace(/\.?0+$/, "");
          styles.push(`line-height: ${lh}`);
        }
      }
    }

    // Indent (w:ind)
    const indEl = getXmlChild(pPr, "ind") || getXmlChild(inheritedPr, "ind");
    if (indEl) {
      const left = indEl.getAttribute("w:left") || indEl.getAttribute("w:start");
      const firstLine = indEl.getAttribute("w:firstLine");
      if (left) {
        const pt = (parseInt(left, 10) / 20).toFixed(1).replace(/\.0$/, "");
        styles.push(`margin-left: ${pt}pt`);
      }
      if (firstLine) {
        const pt = (parseInt(firstLine, 10) / 20).toFixed(1).replace(/\.0$/, "");
        styles.push(`text-indent: ${pt}pt`);
      }
    }

    return styles;
  }

  const body = getXmlChild(xmlDoc, "body") || xmlDoc.querySelector("body");
  if (!body) return "";

  let resultHtml = "";

  for (const child of Array.from(body.children || body.childNodes)) {
    if (child.nodeType !== 1) continue;
    const localName = child.localName || child.tagName.replace(/^w:/, "");

    if (localName === "p") {
      const pPr = getXmlChild(child, "pPr");
      const pStyleEl = getXmlChild(pPr, "pStyle");
      const pStyleId = pStyleEl ? pStyleEl.getAttribute("w:val") : null;
      const pStyles = getParagraphProperties(pPr, pStyleId);

      // Check lists (w:numPr)
      let listPrefix = "";
      const numPr = getXmlChild(pPr, "numPr");
      if (numPr) {
        const numIdEl = getXmlChild(numPr, "numId");
        const ilvlEl = getXmlChild(numPr, "ilvl");
        const numId = numIdEl ? numIdEl.getAttribute("w:val") : "1";
        const ilvl = ilvlEl ? parseInt(ilvlEl.getAttribute("w:val"), 10) : 0;
        
        listCounters[numId] = (listCounters[numId] || 0) + 1;
        const count = listCounters[numId];
        
        // If bullet list
        if (numMap[numId] && numMap[numId].toLowerCase().includes("bullet")) {
          listPrefix = `<span style="display:inline-block; width: 1.2em;">•</span>`;
        } else {
          listPrefix = `<span style="display:inline-block; min-width: 1.4em;">${count}.</span>`;
        }
        if (!pStyles.some(s => s.startsWith("margin-left"))) {
          pStyles.push(`margin-left: ${(ilvl + 1) * 20}px`);
        }
      }

      let innerHtml = listPrefix;
      let hasTextOrMedia = false;

      for (const node of Array.from(child.children || child.childNodes)) {
        if (node.nodeType !== 1) continue;
        const nodeName = node.localName || node.tagName.replace(/^w:/, "");

        if (nodeName === "r") {
          const rPr = getXmlChild(node, "rPr");
          const rStyleEl = getXmlChild(rPr, "rStyle");
          const rStyleId = rStyleEl ? rStyleEl.getAttribute("w:val") : pStyleId;
          const rStyles = getRunStyles(rPr, rStyleId);
          let runText = "";

          for (const rChild of Array.from(node.children || node.childNodes)) {
            if (rChild.nodeType !== 1) continue;
            const rChildName = rChild.localName || rChild.tagName.replace(/^w:/, "");

            if (rChildName === "t") {
              let txt = rChild.textContent || "";
              // Preserve multiple spaces and spaces at start/end of run
              let escaped = escapeHtml(txt);
              escaped = escaped.replace(/  /g, " &nbsp;");
              if (escaped.startsWith(" ")) escaped = "&nbsp;" + escaped.slice(1);
              if (escaped.endsWith(" ")) escaped = escaped.slice(0, -1) + "&nbsp;";
              runText += escaped;
              if (txt.trim()) hasTextOrMedia = true;
            } else if (rChildName === "tab") {
              runText += "&nbsp;&nbsp;&nbsp;&nbsp;";
              hasTextOrMedia = true;
            } else if (rChildName === "br") {
              runText += "<br>";
              hasTextOrMedia = true;
            } else if (rChildName === "noBreakHyphen") {
              runText += "&nbsp;";
            } else if (rChildName === "drawing") {
              const blip = rChild.querySelector ? (rChild.querySelector("blip") || getXmlChild(rChild, "blip")) : null;
              if (blip) {
                const embedId = blip.getAttribute("r:embed");
                if (embedId && mediaMap[embedId]) {
                  runText += `<img src="${mediaMap[embedId]}" style="max-width: 100%; height: auto; display: inline-block; vertical-align: middle;">`;
                  hasTextOrMedia = true;
                }
              }
            }
          }

          if (runText) {
            if (rStyles.length > 0) {
              innerHtml += `<span style="${rStyles.join("; ")}">${runText}</span>`;
            } else {
              innerHtml += runText;
            }
          }
        } else if (nodeName === "hyperlink") {
          const rText = node.textContent || "";
          innerHtml += `<a href="#" style="color: #2563eb; text-decoration: underline;">${escapeHtml(rText)}</a>`;
          if (rText.trim()) hasTextOrMedia = true;
        }
      }

      // Preserve blank lines / paragraph gaps if paragraph has no text
      if (!hasTextOrMedia && (!innerHtml || innerHtml === listPrefix)) {
        innerHtml = "&nbsp;";
      }

      if (!pStyles.some(s => s.startsWith("margin-bottom"))) {
        pStyles.push("margin-bottom: 6px");
      }

      const styleAttr = pStyles.length > 0 ? ` style="${pStyles.join("; ")}"` : "";
      resultHtml += `<p${styleAttr}>${innerHtml}</p>\n`;

    } else if (localName === "tbl") {
      let tblHtml = `<table style="border-collapse: collapse; width: 100%; margin-bottom: 12px; border: 1px solid #cbd5e1;">\n`;
      const rows = getXmlChildren(child, "tr");

      for (const row of rows) {
        tblHtml += "  <tr>\n";
        const cells = getXmlChildren(row, "tc");

        for (const cell of cells) {
          const tcPr = getXmlChild(cell, "tcPr");
          const cellStyles = ["padding: 8px 12px", "border: 1px solid #cbd5e1"];
          let colspan = null;

          if (tcPr) {
            const shd = getXmlChild(tcPr, "shd");
            if (shd) {
              const fill = shd.getAttribute("w:fill");
              const bg = resolveColorValue(fill);
              if (bg) {
                cellStyles.push(`background-color: ${bg}`);
              }
            }
            const gridSpan = getXmlChild(tcPr, "gridSpan");
            if (gridSpan) colspan = gridSpan.getAttribute("w:val");
          }

          let cellText = "";
          const pNodes = getXmlChildren(cell, "p");
          for (const pNode of pNodes) {
            const pPr = getXmlChild(pNode, "pPr");
            const pSt = getParagraphProperties(pPr);
            let pTxt = "";
            const rNodes = getXmlChildren(pNode, "r");
            for (const rNode of rNodes) {
              const rPr = getXmlChild(rNode, "rPr");
              const rSt = getRunStyles(rPr);
              let txt = rNode.textContent || "";
              txt = escapeHtml(txt).replace(/  /g, " &nbsp;");
              if (rSt.length > 0) pTxt += `<span style="${rSt.join("; ")}">${txt}</span>`;
              else pTxt += txt;
            }
            if (!pTxt) pTxt = "&nbsp;";
            const pStyleAttr = pSt.length > 0 ? ` style="${pSt.join("; ")}"` : "";
            cellText += `<p${pStyleAttr}>${pTxt}</p>`;
          }

          const csAttr = cellStyles.join("; ");
          const spanAttr = colspan ? ` colspan="${colspan}"` : "";
          tblHtml += `    <td style="${csAttr}"${spanAttr}>${cellText}</td>\n`;
        }
        tblHtml += "  </tr>\n";
      }
      tblHtml += "</table>\n";
      resultHtml += tblHtml;
    }
  }

  // Repair fragmented placeholder tags across HTML spans
  if (resultHtml) {
    resultHtml = resultHtml.replace(/\{\s*<span[^>]*>([^<{}]+)<\/span>\s*\}/gi, "{$1}");
  }

  return resultHtml;
}

// Import Word (.docx) file and convert to Template HTML
async function importWordTemplateFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".docx")) {
    showToast("Please select a Microsoft Word document (.docx).", "warning");
    return;
  }

  try {
    showToast(`Parsing Word document "${file.name}"...`, "info");
    addLog(`Reading Word document "${file.name}"...`, "system");

    const arrayBuffer = await file.arrayBuffer();
    let htmlContent = "";

    // 1. High-Fidelity JSZip XML Parser: Extracts exact text colors, background colors, font sizes, fonts, spaces, line breaks & alignment
    if (typeof JSZip !== "undefined") {
      try {
        htmlContent = await parseDocxToFullHtml(arrayBuffer);
      } catch (xmlErr) {
        console.warn("JSZip XML parser fallback to Mammoth:", xmlErr);
      }
    }

    // 2. Fallback to Mammoth if JSZip didn't run or returned empty
    if (!htmlContent.trim() && typeof mammoth !== "undefined") {
      const result = await mammoth.convertToHtml({
        arrayBuffer: arrayBuffer,
        ignoreEmptyParagraphs: false
      });
      htmlContent = result.value || "";
    }

    if (!htmlContent.trim()) {
      showToast("Word file appears to be empty or contains no readable text.", "warning");
      return;
    }

    // Check for Subject tag at the start of document
    let extractedSubject = null;
    const tempContainer = document.createElement("div");
    tempContainer.innerHTML = htmlContent;

    const firstElement = tempContainer.querySelector("p, h1, h2, h3, h4");
    if (firstElement) {
      const firstText = firstElement.textContent.trim();
      const subjectMatch = firstText.match(/^Subject\s*[:\-]\s*(.*)$/i);
      if (subjectMatch) {
        extractedSubject = subjectMatch[1].trim();
        firstElement.remove();
        htmlContent = tempContainer.innerHTML;
      }
    }

    // Trim leading empty paragraphs & blank lines at top of email body
    htmlContent = trimLeadingEmptyElements(htmlContent);

    // Update body editor and state
    const bodyEditor = document.getElementById("email-body-editor");
    if (bodyEditor) {
      bodyEditor.innerHTML = htmlContent;
    }
    state.template.body = htmlContent;

    if (extractedSubject) {
      const subjectInput = document.getElementById("email-subject-template");
      if (subjectInput) subjectInput.value = extractedSubject;
      state.template.subject = extractedSubject;
    }

    state.template.docxSource = file.name;

    const banner = document.getElementById("docx-loaded-banner");
    const bannerFilename = document.getElementById("docx-banner-filename");
    if (banner && bannerFilename) {
      bannerFilename.textContent = `Template imported from: ${file.name}`;
      banner.classList.remove("hidden");
    }

    const cleanName = file.name.replace(/\.docx$/i, "").replace(/[\-_]/g, " ");
    if (state.template.name === "Default Template" || state.template.name.startsWith("Word -")) {
      state.template.name = `Word - ${cleanName}`;
      populateTemplateSelector();
    }

    saveTemplateToCache();
    updateLivePreview();

    showToast(`Successfully imported Word template with full formatting: "${file.name}"!`, "success");
    addLog(`Successfully converted Word file "${file.name}" with full formatting, colors, and no top space.`, "success");

  } catch (error) {
    console.error("Error converting Word document:", error);
    showToast(`Failed to parse Word document: ${error.message}`, "error");
    addLog(`Error parsing Word file "${file.name}": ${error.message}`, "error");
  }
}

/* -------------------------------------------------------------
 * ENHANCED MULTI-ACCOUNT SCHEDULING & SHEET ACCOUNTS LOGIC
 * ------------------------------------------------------------- */

// Password Sanitizer Helper (Strips quotes, non-breaking spaces \xa0, zero-width spaces \u200b, and compacts 16-character Google App Passwords)
function sanitizePassword(rawPass, host = "", user = "") {
  if (!rawPass) return "";
  let clean = String(rawPass).replace(/[\xa0\u200b\r\n]/g, "").trim().replace(/^["'`]+|["'`]+$/g, "");
  const compact = clean.replace(/[\s\-]+/g, "");
  if (compact.length === 16) {
    return compact;
  }
  return clean;
}

// Unified Sender Account Resolution Helper
function getSenderAccountForJob(rec = null, template = null) {
  const accounts = state.settings.senderAccounts || [];
  if (accounts.length === 0) return null;

  // 1. Direct senderAccountId on recipient
  if (rec && rec.senderAccountId) {
    const acc = accounts.find(a => a.id === rec.senderAccountId);
    if (acc) return acc;
  }

  // 2. Sender string / email match on recipient
  if (rec && (rec.sender || rec.senderEmail)) {
    let rawSender = (rec.sender || rec.senderEmail || "").trim();
    if (rawSender.includes("<") && rawSender.includes(">")) {
      rawSender = rawSender.split("<")[1].split(">")[0].trim();
    }
    const cleanSender = rawSender.toLowerCase();
    if (cleanSender) {
      const matched = accounts.find(a => 
        (a.user && a.user.toLowerCase() === cleanSender) ||
        (a.label && a.label.toLowerCase() === cleanSender)
      );
      if (matched) return matched;
    }
  }

  // 3. Template senderAccountId
  const tmpl = template || (state.templates ? state.templates.find(t => t.id === (rec ? rec.templateId : state.activeTemplateId)) : null);
  if (tmpl && tmpl.senderAccountId) {
    const acc = accounts.find(a => a.id === tmpl.senderAccountId);
    if (acc) return acc;
  }

  // 4. Default sender account
  const defaultAcc = accounts.find(a => a.isDefault);
  if (defaultAcc) return defaultAcc;

  // 5. Fallback to first account
  return accounts[0];
}

// Host Sanitizer Helper
function sanitizeSmtpHost(rawHost) {
  if (!rawHost) return "";
  let host = String(rawHost).trim().replace(/^["'`]+|["'`]+$/g, "");
  host = host.replace(/^[a-z0-9+\-.]+:\/\//i, "");
  host = host.split("/")[0].split("?")[0].trim();
  if (host.includes(":")) {
    host = host.split(":")[0].trim();
  }
  const hostLower = host.toLowerCase();
  if (hostLower === "gmail.com" || hostLower === "googlemail.com") return "smtp.gmail.com";
  if (hostLower === "outlook.com" || hostLower === "hotmail.com" || hostLower === "live.com" || hostLower === "office365.com" || hostLower === "microsoft.com") return "smtp.office365.com";
  if (hostLower === "yahoo.com" || hostLower === "ymail.com") return "smtp.mail.yahoo.com";
  if (hostLower === "zoho.com") return "smtp.zoho.com";
  if (hostLower === "icloud.com" || hostLower === "me.com") return "smtp.mail.me.com";
  return host;
}

// Auto-detect SMTP host/port/secure from email domain
function autoDetectSmtpSettings(email) {
  const domain = (email || "").split("@")[1] || "";
  const d = domain.toLowerCase();
  if (d.includes("gmail") || d.includes("google") || d === "gr.foundation") {
    return { host: "smtp.gmail.com", port: "465", secure: "ssl" };
  }
  if (d.includes("outlook") || d.includes("hotmail") || d.includes("live") || d.includes("office365") || d.includes("microsoft") || d.includes("msn")) {
    return { host: "smtp.office365.com", port: "587", secure: "tls" };
  }
  if (d.includes("yahoo") || d.includes("ymail") || d.includes("rocketmail")) {
    return { host: "smtp.mail.yahoo.com", port: "465", secure: "ssl" };
  }
  if (d.includes("zoho")) {
    return { host: "smtp.zoho.com", port: "465", secure: "ssl" };
  }
  if (d.includes("icloud") || d.includes("me.com") || d.includes("mac.com")) {
    return { host: "smtp.mail.me.com", port: "587", secure: "tls" };
  }
  if (d.includes("aol")) {
    return { host: "smtp.aol.com", port: "465", secure: "ssl" };
  }
  const customHost = domain ? (domain.startsWith("smtp.") ? domain : `smtp.${domain}`) : "smtp.gmail.com";
  return { host: customHost, port: "465", secure: "ssl" };
}

// Re-link queued recipients to sender accounts whenever sender accounts are updated
function relinkRecipientsSenderAccounts() {
  if (!state.recipients || state.recipients.length === 0) return;
  const accounts = state.settings.senderAccounts || [];
  let relinkCount = 0;

  state.recipients.forEach(r => {
    let matchedAcc = null;
    // Try matching existing senderAccountId
    if (r.senderAccountId) {
      matchedAcc = accounts.find(a => a.id === r.senderAccountId);
    }
    // Try matching by sender email string or label
    if (!matchedAcc && r.sender) {
      let lookup = r.sender.trim().toLowerCase();
      if (lookup.includes("<") && lookup.includes(">")) {
        lookup = lookup.split("<")[1].split(">")[0].trim().toLowerCase();
      }
      matchedAcc = accounts.find(a => 
        a.user.toLowerCase() === lookup || 
        a.label.toLowerCase() === lookup ||
        (a.user && a.user.toLowerCase().includes(lookup))
      );
    }

    if (matchedAcc) {
      if (r.senderAccountId !== matchedAcc.id) {
        r.senderAccountId = matchedAcc.id;
        r.sender = matchedAcc.user;
        relinkCount++;
      }
    }
  });

  saveRecipientsToCache();
  checkUnconfiguredSenderAccounts();
  if (relinkCount > 0) {
    addLog(`Auto-relinked ${relinkCount} recipient job(s) with matching sender account credentials.`, "system");
  }
}

// Check for unconfigured sender emails specified in imported sheets
function checkUnconfiguredSenderAccounts() {
  const unconfiguredSet = new Set();
  const accounts = state.settings.senderAccounts || [];

  state.recipients.forEach(r => {
    if (r.sender) {
      let s = r.sender.trim().toLowerCase();
      if (s.includes("<") && s.includes(">")) {
        s = s.split("<")[1].split(">")[0].trim().toLowerCase();
      }
      const matched = accounts.find(a => 
        a.user.toLowerCase() === s || 
        a.label.toLowerCase() === s
      );
      if (!matched && s.includes("@")) {
        unconfiguredSet.add(s);
      }
    }
  });

  state.unconfiguredSenders = Array.from(unconfiguredSet);
  renderMissingAccountsAlertBanner();
}

// Render banner warning if sheet mentions unconfigured sender accounts
function renderMissingAccountsAlertBanner() {
  const count = (state.unconfiguredSenders || []).length;
  let banner = document.getElementById("missing-accounts-banner");
  
  if (count === 0) {
    if (banner) banner.remove();
    return;
  }

  const container = document.getElementById("parsed-data-section");
  if (!container) return;

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "missing-accounts-banner";
    banner.style.margin = "12px 0";
    banner.style.padding = "12px 16px";
    banner.style.background = "rgba(245, 158, 11, 0.1)";
    banner.style.border = "1px solid rgba(245, 158, 11, 0.3)";
    banner.style.borderRadius = "var(--radius-md)";
    banner.style.display = "flex";
    banner.style.alignItems = "center";
    banner.style.justifyContent = "space-between";
    banner.style.gap = "12px";
    banner.style.flexWrap = "wrap";
    
    container.insertBefore(banner, container.firstChild);
  }

  const sendersList = state.unconfiguredSenders.slice(0, 3).join(", ") + (count > 3 ? ` +${count - 3} more` : "");

  banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <i data-lucide="alert-triangle" style="color: var(--color-amber); width: 18px; height: 18px; flex-shrink: 0;"></i>
      <span style="font-size: 13px; color: var(--text-primary); font-weight: 500;">
        Sheet specifies <strong>${count} unconfigured sender account(s)</strong>: <code style="color: var(--color-amber); font-weight: 600;">${escapeHtml(sendersList)}</code>
      </span>
    </div>
    <button class="btn btn-indigo btn-sm" id="btn-open-quick-accounts" style="padding: 6px 12px; font-weight: 700; white-space: nowrap;">
      <i data-lucide="key-round" style="width: 14px; height: 14px; margin-right: 4px;"></i> 1-Click Quick Setup
    </button>
  `;

  const btnOpenQuick = document.getElementById("btn-open-quick-accounts"); if (btnOpenQuick) btnOpenQuick.addEventListener("click", openQuickAccountsModal);
  lucide.createIcons();
}

// Open Quick Multi-Account Setup Modal
function openQuickAccountsModal() {
  const modal = document.getElementById("quick-accounts-modal");
  const countEl = document.getElementById("quick-missing-count");
  const listEl = document.getElementById("quick-accounts-form-list");

  if (!modal || !listEl) return;

  const missing = state.unconfiguredSenders || [];
  if (missing.length === 0) {
    showToast("All sender accounts are already configured!", "info");
    return;
  }

  countEl.textContent = missing.length;
  listEl.innerHTML = "";

  missing.forEach((email, idx) => {
    const defaults = autoDetectSmtpSettings(email);
    const domainLabel = email.split("@")[1] || "Account";

    const card = document.createElement("div");
    card.style.background = "var(--bg-secondary)";
    card.style.border = "1px solid var(--border-color)";
    card.style.borderRadius = "var(--radius-sm)";
    card.style.padding = "14px";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "10px";

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 13px; font-weight: 700; color: var(--color-indigo); display: flex; align-items: center; gap: 6px;">
          <i data-lucide="mail" style="width: 14px; height: 14px;"></i> ${escapeHtml(email)}
        </span>
        <span class="badge badge-outline-gray" style="font-size: 10px;">Detected: ${escapeHtml(defaults.host)}</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
        <div>
          <label style="font-size: 11px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 3px;">Account Label</label>
          <input type="text" class="form-control xs-input quick-acc-label" value="${escapeHtml(domainLabel)} (${escapeHtml(email.split("@")[0])})" style="font-size: 12px; padding: 4px 8px;">
        </div>
        <div>
          <label style="font-size: 11px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 3px;">Password / App Password</label>
          <input type="password" class="form-control xs-input quick-acc-pass" placeholder="Enter password..." style="font-size: 12px; padding: 4px 8px;" data-user="${escapeHtml(email)}">
        </div>
        <div>
          <label style="font-size: 11px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 3px;">SMTP Host:Port</label>
          <div style="display: flex; gap: 4px;">
            <input type="text" class="form-control xs-input quick-acc-host" value="${escapeHtml(defaults.host)}" style="font-size: 11px; padding: 4px 6px; flex-grow: 1;">
            <input type="number" class="form-control xs-input quick-acc-port" value="${escapeHtml(defaults.port)}" style="font-size: 11px; padding: 4px 6px; width: 55px;">
          </div>
        </div>
      </div>
    `;
    listEl.appendChild(card);
  });

  modal.classList.remove("hidden");
  lucide.createIcons();
}

function closeQuickAccountsModal() {
  const modal = document.getElementById("quick-accounts-modal");
  if (modal) modal.classList.add("hidden");
}

// Save Quick Multi-Account Setup
function saveQuickAccounts() {
  const listEl = document.getElementById("quick-accounts-form-list");
  if (!listEl) return;

  const cards = listEl.children;
  let added = 0;

  if (!state.settings.senderAccounts) state.settings.senderAccounts = [];

  Array.from(cards).forEach(card => {
    const passInput = card.querySelector(".quick-acc-pass");
    const user = passInput.getAttribute("data-user");
    const pass = passInput.value.trim();
    const label = card.querySelector(".quick-acc-label").value.trim() || user;
    const rawHost = card.querySelector(".quick-acc-host").value.trim();
    const host = sanitizeSmtpHost(rawHost) || autoDetectSmtpSettings(user).host;
    const port = card.querySelector(".quick-acc-port").value.trim() || autoDetectSmtpSettings(user).port;

    if (pass) {
      const exists = state.settings.senderAccounts.some(a => a.user.toLowerCase() === user.toLowerCase());
      if (!exists) {
        state.settings.senderAccounts.push({
          id: `acc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          label: label,
          user: user,
          pass: pass,
          host: host,
          port: port,
          secure: port === "587" ? "tls" : "ssl",
          isDefault: state.settings.senderAccounts.length === 0
        });
        added++;
      }
    }
  });

  if (added > 0) {
    saveSettingsToCache();
    renderSenderAccountsTable();
    populateSenderDropdowns();
    relinkRecipientsSenderAccounts();
    renderQueueTable();
    showToast(`Configured ${added} new sender account(s) successfully!`, "success");
    addLog(`Configured ${added} new sender account(s) via Quick Setup.`, "success");
  } else {
    showToast("No account passwords were entered.", "warning");
  }

  closeQuickAccountsModal();
}

// Import Accounts from Excel or CSV sheet
function importAccountsFromSheetData(rows) {
  if (!rows || rows.length === 0) return 0;
  
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const vals = Object.values(rows[i]).map(v => String(v).toLowerCase());
    if (vals.some(v => v.includes("email") || v.includes("user") || v.includes("account"))) {
      headerRowIndex = i;
      break;
    }
  }

  const headerRow = rows[headerRowIndex];
  const getCol = (alts) => {
    for (const alt of alts) {
      const match = Object.keys(headerRow).find(key => {
        const val = String(headerRow[key]).trim().toLowerCase();
        return val === alt.toLowerCase() || val.includes(alt.toLowerCase());
      });
      if (match) return match;
    }
    return null;
  };

  const labelCol = getCol(["Label", "Account Name", "Name", "Account"]);
  const userCol = getCol(["Email", "User", "Username", "Email ID", "Email Address", "Account Email"]);
  const passCol = getCol(["Password", "Pass", "App Password", "SMTP Password"]);
  const hostCol = getCol(["Host", "SMTP Host", "Server"]);
  const portCol = getCol(["Port", "SMTP Port"]);
  const secureCol = getCol(["Secure", "Security", "Encryption", "TLS", "SSL"]);

  if (!userCol || !passCol) return 0;

  if (!state.settings.senderAccounts) state.settings.senderAccounts = [];
  let addedCount = 0;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const user = String(r[userCol] || "").trim();
    const pass = String(r[passCol] || "").trim();
    if (!user || !pass) continue;

    let label = labelCol ? String(r[labelCol] || "").trim() : user;
    if (!label) label = user;

    const defaults = autoDetectSmtpSettings(user);
    const rawHost = hostCol && String(r[hostCol]).trim() ? String(r[hostCol]).trim() : defaults.host;
    const host = sanitizeSmtpHost(rawHost) || defaults.host;
    const port = portCol && String(r[portCol]).trim() ? String(r[portCol]).trim() : defaults.port;
    const secure = secureCol && String(r[secureCol]).trim() ? String(r[secureCol]).trim().toLowerCase() : defaults.secure;

    const exists = state.settings.senderAccounts.some(a => a.user.toLowerCase() === user.toLowerCase());
    if (!exists) {
      state.settings.senderAccounts.push({
        id: `acc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        label: label,
        user: user,
        pass: sanitizePassword(pass, host, user),
        host: host,
        port: port,
        secure: secure.includes("tls") ? "tls" : (secure.includes("none") ? "none" : "ssl"),
        isDefault: state.settings.senderAccounts.length === 0
      });
      addedCount++;
    }
  }

  if (addedCount > 0) {
    saveSettingsToCache();
    renderSenderAccountsTable();
    populateSenderDropdowns();
    relinkRecipientsSenderAccounts();
    renderQueueTable();
    showToast(`Bulk imported ${addedCount} sender account(s) from sheet!`, "success");
    addLog(`Bulk imported ${addedCount} sender account(s) from sheet.`, "success");
  }

  return addedCount;
}

// Bulk Import Accounts File Handler
function importAccountsFromSheetFile(file) {
  if (!file) return;
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const data = e.target.result;
      const workbook = XLSX.read(data, { type: "binary" });
      let totalImported = 0;

      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: "A", raw: false, defval: "" });
        totalImported += importAccountsFromSheetData(rows);
      });

      if (totalImported === 0) {
        showToast("No valid sender account rows (Email & Password required) found in file.", "warning");
      }
    } catch (err) {
      showToast(`Failed to parse accounts file: ${err.message}`, "error");
    }
  };

  reader.readAsBinaryString(file);
}


// Delete a single recipient from either table
function deleteRecipient(id) {
  const rec = state.recipients.find(r => r.id === id);
  const nameStr = rec ? rec.name : "recipient";
  if (!confirm(`Are you sure you want to delete ${nameStr}?`)) {
    return;
  }
  state.recipients = state.recipients.filter(r => r.id !== id);
  saveRecipientsToCache();
  renderExcelTable();
  renderQueueTable();
  updateSummaryStats();
  populateRecipientDropdown();
  populateTemplateSelector();
  showToast(`Deleted ${nameStr}`, "info");
  addLog(`Deleted recipient ${nameStr} from list.`, "warning");
}

// Delete selected rows from Excel preview table
function deleteSelectedExcelRows() {
  const selectedCbs = document.querySelectorAll(".excel-row-checkbox:checked");
  if (selectedCbs.length === 0) {
    showToast("Please select at least one contact to delete.", "warning");
    return;
  }

  if (!confirm(`Are you sure you want to delete ${selectedCbs.length} selected contact(s)?`)) {
    return;
  }

  const selectedIds = Array.from(selectedCbs).map(cb => cb.getAttribute("data-id"));
  state.recipients = state.recipients.filter(r => !selectedIds.includes(r.id));

  saveRecipientsToCache();
  renderExcelTable();
  renderQueueTable();
  updateSummaryStats();
  populateRecipientDropdown();
  populateTemplateSelector();

  showToast(`Deleted ${selectedIds.length} contact(s)`, "info");
  addLog(`Batch deleted ${selectedIds.length} contact(s) from Excel list.`, "warning");
}

// Apply selected sender account to checked queue rows
function applyBatchAccount() {
  const selectedCbs = document.querySelectorAll(".queue-row-checkbox:checked");
  if (selectedCbs.length === 0) {
    showToast("Please select at least one row in the queue.", "warning");
    return;
  }

  const targetAccountId = document.getElementById("batch-assign-account-select").value;
  const targetAccObj = (state.settings.senderAccounts || []).find(a => a.id === targetAccountId);
  const targetAccName = targetAccObj ? targetAccObj.label : "Default Sender";

  selectedCbs.forEach(cb => {
    const recId = cb.getAttribute("data-id");
    const rec = state.recipients.find(r => r.id === recId);
    if (rec) {
      rec.senderAccountId = targetAccountId;
      if (targetAccObj) {
        rec.sender = targetAccObj.user;
      }
    }
  });

  saveRecipientsToCache();
  renderQueueTable();
  renderExcelTable();
  showToast(`Assigned account "${targetAccName}" to ${selectedCbs.length} recipient(s)!`, "success");
  addLog(`Batch assigned account "${targetAccName}" to ${selectedCbs.length} recipient(s).`, "system");
}

// Mark selected queue rows as Sent
function markSelectedAsSent() {
  const selectedCbs = document.querySelectorAll(".queue-row-checkbox:checked");
  if (selectedCbs.length === 0) {
    showToast("Please select at least one row in the queue.", "warning");
    return;
  }

  let count = 0;
  selectedCbs.forEach(cb => {
    const recId = cb.getAttribute("data-id");
    const rec = state.recipients.find(r => r.id === recId);
    if (rec) {
      rec.status = "Sent";
      rec.error = "Manually marked as Sent";
      markJobAsSent(rec);
      count++;
    }
  });

  saveRecipientsToCache();
  renderQueueTable();
  updateSummaryStats();
  showToast(`Marked ${count} recipient(s) as Sent!`, "success");
  addLog(`Manually marked ${count} recipient(s) as Sent.`, "system");
}

// Reset selected queue rows to Pending
function markSelectedAsPending() {
  const selectedCbs = document.querySelectorAll(".queue-row-checkbox:checked");
  if (selectedCbs.length === 0) {
    showToast("Please select at least one row in the queue.", "warning");
    return;
  }

  let count = 0;
  selectedCbs.forEach(cb => {
    const recId = cb.getAttribute("data-id");
    const rec = state.recipients.find(r => r.id === recId);
    if (rec) {
      rec.status = "Pending";
      delete rec.error;
      count++;
    }
  });

  saveRecipientsToCache();
  renderQueueTable();
  updateSummaryStats();
  showToast(`Reset ${count} recipient(s) to Pending!`, "info");
  addLog(`Reset status of ${count} recipient(s) to Pending.`, "system");
}
