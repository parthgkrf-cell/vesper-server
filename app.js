/* -------------------------------------------------------------
 * VESPER MAIL SCHEDULER — CORE ENGINE & UI LOGIC
 * ------------------------------------------------------------- */

// State Object
let state = {
  recipients: [],
  stagedImportFiles: [],
  queueFilters: {
    template: "all",
    file: "all",
    status: "all",
    search: ""
  },
  template: {
    subject: "Quick question regarding {Affiliation}",
    cc: "",
    bcc: "",
    body: "Dear {Name},\n\nI hope this email finds you well at {Affiliation}.\n\nThis is a scheduled follow-up email custom tailored for you. We will send this to your email {Email} at your scheduled slot: {Time}.\n\nBest regards,\nYour Personal Scheduler",
    senderAccountId: "",
    action: "send"
  },
  settings: {
    method: "localserver_send",
    localUrl: window.location.origin.startsWith("http") ? window.location.origin + "/send" : "http://localhost:3000/send",
    localAction: "send",
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
        if (config.recipients) {
          // Re-hydrate Date objects
          state.recipients = config.recipients.map(r => ({
            ...r,
            parsedTime: r.parsedTime ? new Date(r.parsedTime) : null
          }));
        }
        if (config.headers) {
          state.headers = config.headers;
          localStorage.setItem("vesper_headers", JSON.stringify(state.headers));
        }
        // Force upgrade/migration for settings method
        if (state.settings.method !== "localserver_send" && state.settings.method !== "localserver_draft") {
          state.settings.method = state.settings.localAction === "draft" ? "localserver_draft" : "localserver_send";
        }
        // Cache to localStorage
        localStorage.setItem("vesper_settings", JSON.stringify(state.settings));
        if (state.templates) {
          localStorage.setItem("vesper_templates", JSON.stringify(state.templates));
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
    if (window.location.protocol.startsWith("http")) {
      await fetch("/api/config", {
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
          headers: state.headers
        })
      });
    }
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
        subject: oldTemplate?.subject || "Quick question regarding {Affiliation}",
        cc: oldTemplate?.cc || "",
        bcc: oldTemplate?.bcc || "",
        body: oldTemplate?.body || "Dear {Name},\n\nI hope this email finds you well at {Affiliation}.\n\nThis is a scheduled follow-up email custom tailored for you. We will send this to your email {Email} at your scheduled slot: {Time}.\n\nBest regards,\nYour Personal Scheduler",
        senderAccountId: oldTemplate?.senderAccountId || "",
        action: oldTemplate?.action || "send"
      }
    ];
    state.activeTemplateId = "template-default";
  }

  // Set the active template reference
  state.template = state.templates.find(t => t.id === state.activeTemplateId) || state.templates[0];

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

function saveTemplateToCache() {
  localStorage.setItem("vesper_template", JSON.stringify(state.template));
  localStorage.setItem("vesper_templates", JSON.stringify(state.templates));
  localStorage.setItem("vesper_active_template_id", state.activeTemplateId);
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
  document.getElementById("email-action-template").value = state.template.action || "send";

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
      });
    }
  });

  // Add Sender Account Event Listener
  const btnAddAcc = document.getElementById("btn-add-sender-account");
  if (btnAddAcc) {
    btnAddAcc.addEventListener("click", () => {
      const label = document.getElementById("acc-label").value.trim();
      const user = document.getElementById("acc-user").value.trim();
      const pass = document.getElementById("acc-pass").value.trim();
      const host = document.getElementById("acc-host").value.trim();
      const port = document.getElementById("acc-port").value.trim();
      const secure = document.getElementById("acc-secure").value;

      if (!label || !user || !pass || !host || !port) {
        showToast("Please fill in all SMTP account fields.", "warning");
        return;
      }

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
      renderQueueTable(); // updates dropdowns in queue
      showToast("Sender account added successfully!", "success");
      addLog(`Added sender account: ${label} (${user})`, "success");
    });
  }

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
    actionSelect.addEventListener("change", (e) => {
      state.template.action = e.target.value;
      saveTemplateToCache();
      showToast(`Default action set to ${e.target.value === 'draft' ? 'Draft' : 'Send'}`, "info");
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

  // Color selection in picker
  document.querySelectorAll(".color-box").forEach(box => {
    box.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Prevents selection loss when clicking color boxes
    });
    box.addEventListener("click", (e) => {
      e.preventDefault();
      let type = box.getAttribute("data-type");
      const color = box.getAttribute("data-color");
      
      // Map legacy commands to modern browser standards for document.execCommand
      if (type === "backcolor" || type === "backColor") {
        type = "hiliteColor";
      } else if (type === "forecolor") {
        type = "foreColor";
      }

      restoreSelection();
      document.execCommand(type, false, color);
      bodyEditor.focus();
      state.template.body = bodyEditor.innerHTML;
      saveTemplateToCache();
      updateLivePreview();
    });
  });

  // Custom Color input listener
  const customColorInput = document.getElementById("custom-color-input");
  const customColorType = document.getElementById("custom-color-type");
  if (customColorInput && customColorType) {
    // Stop click propagation so dropdown doesn't close, and prevent selection loss
    customColorInput.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
    customColorType.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Prevents selection loss when clicking dropdown select
      e.stopPropagation();
    });
    customColorType.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    
    customColorInput.addEventListener("change", (e) => {
      const color = e.target.value;
      let type = customColorType.value; // 'forecolor' or 'backcolor'
      
      // Map legacy commands to modern browser standards for document.execCommand
      if (type === "backcolor" || type === "backColor") {
        type = "hiliteColor";
      } else if (type === "forecolor") {
        type = "foreColor";
      }

      restoreSelection();
      document.execCommand(type, false, color);
      bodyEditor.focus();
      state.template.body = bodyEditor.innerHTML;
      saveTemplateToCache();
      updateLivePreview();
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
      saveTemplateToCache();
      showToast("Template saved successfully!", "success");
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
  const btnDeleteSelectedBatch = document.getElementById("btn-delete-selected-batch");

  if (btnApplyBatchTemplate) {
    btnApplyBatchTemplate.addEventListener("click", applyBatchTemplate);
  }
  if (btnDeleteSelectedBatch) {
    btnDeleteSelectedBatch.addEventListener("click", deleteSelectedQueueRows);
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

  // Export Excel template button
  document.getElementById("btn-download-sample").addEventListener("click", downloadSampleExcel);

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
    btnResetApp.addEventListener("click", () => {
      if (confirm("Are you absolutely sure you want to reset the entire application? This will clear all SMTP credentials, sender accounts, mailing lists, and email templates, and cannot be undone.")) {
        localStorage.clear();
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
        dispatchEmail(rec);
      }
    });

    // Uncheck select all
    document.getElementById("select-all-queue-rows").checked = false;
  });

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
      return { hours, minutes, seconds };
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
        return { hours, minutes, seconds };
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
        seconds: dVal.getSeconds()
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
      if (frac > 0) {
        const totSec = Math.round(frac * 86400);
        hours = Math.floor(totSec / 3600) % 24;
        minutes = Math.floor((totSec % 3600) / 60);
        seconds = totSec % 60;
      }
      return {
        year: d.getFullYear(),
        monthIndex: d.getMonth(),
        day: d.getDate(),
        hours, minutes, seconds
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
          return { year, monthIndex, day, hours: 0, minutes: 0, seconds: 0 };
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
          seconds: fullDate.getSeconds()
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

    const labelHtml = `
      <div style="display: flex; flex-direction: column;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          <i data-lucide="file-spreadsheet" style="width: 14px; height: 14px; color: var(--color-indigo);"></i>
          ${escapeHtml(staged.fileName)} <span class="badge badge-outline-gray" style="font-size: 10px;">${escapeHtml(staged.sheetName)}</span>
        </span>
        <span style="font-size: 11px; color: var(--text-muted);">${staged.rows.length} total rows parsed</span>
      </div>
    `;

    const select = document.createElement("select");
    select.className = "form-control xs-input";
    select.style.padding = "4px 8px";
    select.style.fontSize = "12px";
    select.style.maxWidth = "260px";

    const autoOpt = document.createElement("option");
    autoOpt.value = "auto";
    autoOpt.textContent = "⚡ Auto-Detect (Column header or Sheet)";
    select.appendChild(autoOpt);

    state.templates.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `Template: ${t.name}`;
      if (staged.selectedTemplateId === t.id) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    select.addEventListener("change", (e) => {
      staged.selectedTemplateId = e.target.value;
    });

    itemRow.innerHTML = labelHtml;
    itemRow.appendChild(select);
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
    const { added, invalid } = processImportedRows(staged.rows, staged.fileName, staged.sheetName, staged.selectedTemplateId);
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

  showToast(`Successfully imported ${totalAdded} recipients!`, "success");
  addLog(`Batch Import complete: Added ${totalAdded} recipients across ${state.recipients.length} total queue items. Discarded ${totalDiscarded} incomplete rows.`, "success");
}

// Clean and map imported columns to standardized format
function processImportedRows(rows, fileName = "Upload.xlsx", sheetName = "Sheet1", defaultTemplateId = "auto") {
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
  const senderCol = getColumnLetter(headerRow, ["Sender", "Sender Email", "From", "Send From"]);
  const senderNameCol = getColumnLetter(headerRow, ["Sender Name", "SenderName", "FromName", "From Name", "Sender_Name"]);
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

    // Match sender account
    let matchedAcc = null;
    const lookupSender = (derivedSender || "").toLowerCase();
    if (lookupSender && state.settings.senderAccounts) {
      matchedAcc = state.settings.senderAccounts.find(acc => 
        acc.user.toLowerCase() === lookupSender || 
        acc.label.toLowerCase() === lookupSender
      );
    }
    const senderAccountId = matchedAcc ? matchedAcc.id : (state.template.senderAccountId || "");

    // Match action
    let action = "send";
    if (actionStr) {
      if (actionStr.includes("draft") || actionStr.includes("save")) {
        action = "draft";
      } else if (actionStr.includes("send") || actionStr.includes("smtp")) {
        action = "send";
      }
    } else {
      action = state.template.action || "send";
    }

    // Capture ALL raw column values by letter
    const colValues = {};
    colLetters.forEach(col => {
      colValues[col] = getStringValue(row[col]);
    });

    state.recipients.push({
      id: `recipient-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
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
      parsedTime: parsedTime || new Date(),
      templateId: rowTemplateId,
      sourceFile: fileName,
      sourceSheet: sheetName,
      senderAccountId: senderAccountId,
      sender: derivedSender || (matchedAcc ? matchedAcc.user : ""),
      senderName: derivedSenderName,
      action: action,
      cc: cc || state.template.cc || "",
      bcc: bcc || state.template.bcc || "",
      status: "Pending",
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

    row.innerHTML = `
      <td>${idx + 1}</td>
      <td class="text-bold">${escapeHtml(rec.name)}</td>
      <td class="text-teal">${escapeHtml(rec.email)}</td>
      <td>${escapeHtml(rec.affiliation)}</td>
      <td><span class="badge badge-indigo" title="Assigned Template">${escapeHtml(templateName)}</span></td>
      <td><span class="badge badge-outline-gray">${fileSourceStr}</span></td>
      <td>${escapeHtml(rec.date || "—")}</td>
      <td>${escapeHtml(rec.techScheduleName || "—")}</td>
      <td><code>${escapeHtml(rec.rawSDate || "—")}</code></td>
      <td><code>${escapeHtml(rec.rawSTime || "Now")}</code></td>
      <td>${displayTime}</td>
    `;
    tbody.appendChild(row);
  });
}

// Populate Filter Options for Queue
function updateQueueFilterDropdowns() {
  const templateSelect = document.getElementById("queue-filter-template");
  const fileSelect = document.getElementById("queue-filter-file");
  const batchTemplateSelect = document.getElementById("batch-assign-template-select");

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

  if (batchTemplateSelect) {
    batchTemplateSelect.innerHTML = "";
    state.templates.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      batchTemplateSelect.appendChild(opt);
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
  const fStatus = state.queueFilters.status;
  const fSearch = state.queueFilters.search;

  if (fTemp && fTemp !== "all") {
    filtered = filtered.filter(r => (r.templateId || state.activeTemplateId) === fTemp);
  }
  if (fFile && fFile !== "all") {
    filtered = filtered.filter(r => (r.sourceFile || "Upload.xlsx") === fFile);
  }
  if (fStatus && fStatus !== "all") {
    filtered = filtered.filter(r => r.status === fStatus);
  }
  if (fSearch) {
    const q = fSearch.toLowerCase();
    filtered = filtered.filter(r => 
      r.name.toLowerCase().includes(q) || 
      r.email.toLowerCase().includes(q) || 
      r.affiliation.toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="text-center text-muted" style="padding: 30px 16px;">No jobs match the active template or file filters.</td>
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
    const senderSelect = document.createElement("select");
    senderSelect.className = "form-control xs-input";
    senderSelect.style.padding = "4px 8px";
    senderSelect.style.fontSize = "12px";
    senderSelect.style.height = "auto";
    
    if (!state.settings.senderAccounts || state.settings.senderAccounts.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "-- None --";
      senderSelect.appendChild(opt);
    } else {
      state.settings.senderAccounts.forEach(acc => {
        const opt = document.createElement("option");
        opt.value = acc.id;
        opt.textContent = acc.label;
        if (rec.senderAccountId === acc.id) opt.selected = true;
        senderSelect.appendChild(opt);
      });
    }
    
    senderSelect.addEventListener("change", (e) => {
      rec.senderAccountId = e.target.value;
      saveRecipientsToCache();
      const acc = state.settings.senderAccounts.find(a => a.id === rec.senderAccountId);
      addLog(`Updated sender for ${rec.name} to ${acc ? acc.label : 'Default'}.`, "system");
    });
    senderTd.appendChild(senderSelect);
    row.appendChild(senderTd);

    // Action Dropdown
    const actionTd = document.createElement("td");
    const actionSelect = document.createElement("select");
    actionSelect.className = "form-control xs-input";
    actionSelect.style.padding = "4px 8px";
    actionSelect.style.fontSize = "12px";
    actionSelect.style.height = "auto";
    
    const sendOpt = document.createElement("option");
    sendOpt.value = "send";
    sendOpt.textContent = "Send (SMTP)";
    if (rec.action === "send") sendOpt.selected = true;
    actionSelect.appendChild(sendOpt);

    const draftOpt = document.createElement("option");
    draftOpt.value = "draft";
    draftOpt.textContent = "Draft (IMAP)";
    if (rec.action === "draft") draftOpt.selected = true;
    actionSelect.appendChild(draftOpt);

    actionSelect.addEventListener("change", (e) => {
      rec.action = e.target.value;
      saveRecipientsToCache();
      addLog(`Updated action for ${rec.name} to ${rec.action === 'draft' ? 'Draft' : 'Send'}.`, "system");
    });
    actionTd.appendChild(actionSelect);
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

    // Single Action button
    const ctrlTd = document.createElement("td");
    const playBtn = document.createElement("button");
    playBtn.className = "btn btn-secondary btn-sm";
    playBtn.innerHTML = `<i data-lucide="zap"></i>`;
    playBtn.title = "Dispatch Now";
    playBtn.addEventListener("click", () => {
      addLog(`Manual force dispatch triggered for ${rec.name}...`, "system");
      dispatchEmail(rec);
    });
    ctrlTd.appendChild(playBtn);
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
    return `<span class="badge badge-outline-green" title="Dispatched successfully">Sent</span>`;
  }
  if (status === "Sending") {
    return `<span class="badge badge-outline-yellow" title="Currently sending">Sending...</span>`;
  }
  if (status === "Failed") {
    return `<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
              <span class="badge badge-outline-red" style="cursor:help;">Failed</span>
              <span style="font-size: 10px; color: var(--color-rose); max-width: 150px; white-space: normal; word-break: break-word; line-height: 1.2;">${error || 'Unknown Error'}</span>
            </div>`;
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
  const sent = state.recipients.filter(r => r.status === "Sent").length;
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
  replaceTag("{Sender}", rec.sender);
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
    container.style.justifyContent = "center";
    container.style.gap = "20px";
    container.style.alignItems = "flex-start";
    
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
      frame.style.height = "420px";
      frame.style.maxWidth = "100%";
      frame.innerHTML = `
        <div class="email-mockup-header">
          <div class="mockup-dot red"></div>
          <div class="mockup-dot yellow"></div>
          <div class="mockup-dot green"></div>
          <div class="mockup-title" style="color: var(--color-indigo); font-weight: 700;">Template: ${escapeHtml(t.name)}</div>
        </div>
        <div class="email-mockup-content" style="flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto;">
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
          <div class="email-body-pane" style="flex-grow: 1; padding: 16px; min-height: 150px; background: white; overflow-y: auto;">
            ${body}
          </div>
        </div>
      `;
      container.appendChild(frame);
    });
  } else {
    container.style.flexDirection = "column";
    container.style.flexWrap = "nowrap";
    container.style.justifyContent = "center";
    container.style.alignItems = "center";
    container.style.gap = "0";
    
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
        <div class="email-mockup-content" style="flex-grow: 1; display: flex; flex-direction: column; overflow-y: auto;">
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
          <div class="email-body-pane" style="flex-grow: 1; padding: 16px; min-height: 150px; background: white; overflow-y: auto;">
            ${body}
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
      const targetTime = rec.parsedTime ? rec.parsedTime.getTime() : now;
      if (now >= targetTime) {
        // Time hit, trigger dispatch!
        dispatchEmail(rec);
      }
    }
  });
}

// Resolve final sender display name from recipient (Excel Sender column) or account settings
function getFinalSenderName(rec, acc) {
  if (rec) {
    if (rec.senderName && rec.senderName.trim()) {
      return rec.senderName.trim();
    }
    if (rec.sender && rec.sender.trim()) {
      const s = rec.sender.trim();
      if (s.includes('<') && s.includes('>')) {
        const namePart = s.split('<')[0].trim().replace(/^["'\s]+|["'\s]+$/g, '');
        if (namePart) return namePart;
      }
      if (!s.includes('@') || s.includes(' ')) {
        return s;
      }
    }
  }
  if (acc && acc.label && acc.label.trim()) {
    return acc.label.trim();
  }
  if (acc && acc.user && acc.user.trim()) {
    return acc.user.trim();
  }
  return "";
}

// Send actual email trigger
function dispatchEmail(rec) {
  rec.status = "Sending";
  updateRecStatusUI(rec);
  updateSummaryStats();

  const templateId = rec.templateId || state.activeTemplateId;
  const jobTemplate = state.templates.find(t => t.id === templateId) || state.templates[0];
  const subject = renderTemplate(jobTemplate.subject, rec);
  const body = renderTemplate(jobTemplate.body, rec);

  const accId = rec.senderAccountId || jobTemplate.senderAccountId;
  const acc = (state.settings.senderAccounts || []).find(a => a.id === accId) || (state.settings.senderAccounts || []).find(a => a.isDefault);

  if (!acc) {
    failDispatch(rec, "No SMTP sender account configured/matched for this job. Go to Configuration.");
    return;
  }

  const isDraft = rec.action === "draft";
  const logAction = isDraft ? "draft upload" : "SMTP transaction";
  addLog(`[Local Server] Routing ${logAction} for ${rec.name} using account ${acc.label} (${acc.user})...`, "system");

  const finalSenderName = getFinalSenderName(rec, acc);

  fetch(state.settings.localUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: rec.action || "send",
      host: acc.host,
      port: parseInt(acc.port),
      secure: acc.secure,
      user: acc.user,
      pass: acc.pass,
      senderEmail: finalSenderName,
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
      rec.status = "Sent";
      const msgType = isDraft ? "IMAP Draft" : "SMTP Server";
      const successText = isDraft ? "saved draft" : "relayed email";
      addLog(`[${msgType}] ${successText} successfully to ${rec.name} (${rec.email})`, "success");
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

  const subject = "[Test Vesper] verification email check";
  const body = "This is an instant verification check verifying that your Vesper Mail Scheduler configurations are working correctly.\n\nMode: " + state.settings.method;

  const accId = state.template.senderAccountId;
  const acc = (state.settings.senderAccounts || []).find(a => a.id === accId) || (state.settings.senderAccounts || []).find(a => a.isDefault);

  if (!acc) {
    addLog("[Test Email Fail] No SMTP sender account configured or selected.", "error");
    showToast("No Sender Account Configured", "error");
    return;
  }

  const isDraft = state.template.action === "draft";
  fetch(state.settings.localUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: state.template.action || "send",
      host: acc.host,
      port: parseInt(acc.port),
      secure: acc.secure,
      user: acc.user,
      pass: acc.pass,
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
      const msgType = isDraft ? "Draft Success" : "Test Email Success";
      const actionText = isDraft ? "saved verification draft inside your account!" : "sent verification mail!";
      addLog(`[${msgType}] Relay server ${actionText} using account ${acc.label} (${acc.user})`, "success");
      showToast(isDraft ? "Draft saved successfully!" : "Test email sent!", "success");
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
    const now = new Date();
    // Generate scheduled times for templates
    const t1 = new Date(now.getTime() + 5 * 60 * 1000); // 5 mins later
    const t2 = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins later
    const t3 = new Date(now.getTime() + 60 * 60 * 1000); // 1 hr later

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
      ["Name", "Email", "Affiliation", "Template", "Date", "Technical Schedual Name", "S_Date", "S_Time", "CC", "BCC", "Sender", "Action"],
      ["Devin Allen", "devin@example.com", "Acme Corporation", "Default Template", "2026-07-15", "Routine Maintenance", formatDate(t1), formatTimeOnly(t1), "manager@acme.com", "", "sender1@gmail.com", "send"],
      ["Elena Rostova", "elena@example.com", "Apex Labs", "Default Template", "2026-07-16", "Database Upgrade", formatDate(t2), formatTimeOnly(t2), "", "", "sender2@gmail.com", "draft"]
    ];

    const sheet2Data = [
      ["Name", "Email", "Affiliation", "Template", "Date", "Technical Schedual Name", "S_Date", "S_Time", "CC", "BCC", "Sender", "Action"],
      ["Dr. Marcus Vance", "marcus@example.com", "Stanford University", "Executive Follow-up", "2026-07-17", "Server Deployment", formatDate(t3), formatTimeOnly(t3), "admin@stanford.edu", "archive@stanford.edu", "", "send"],
      ["Sarah Jenkins", "sarah@example.com", "Freelance", "Executive Follow-up", "2026-07-18", "API Integration", formatDate(now), "04:30 PM", "", "", "", "draft"]
    ];

    const workbook = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(sheet1Data);
    const ws2 = XLSX.utils.aoa_to_sheet(sheet2Data);

    XLSX.utils.book_append_sheet(workbook, ws1, "Campaign A - Standard");
    XLSX.utils.book_append_sheet(workbook, ws2, "Campaign B - Executives");

    XLSX.writeFile(workbook, "vesper_sdate_stime_sample.xlsx");
    showToast("Downloaded S_Date & S_Time sample Excel file!", "success");
    addLog("Generated and downloaded S_Date & S_Time sample Excel workbook.", "system");

  } catch (err) {
    showToast(`Template download failed: ${err.message}`, "error");
  }
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
          badge.className = "connection-status-badge status-suggested";
          badge.textContent = `Status: Found on port ${port} (Click to apply)`;
          badge.setAttribute("data-suggested-url", suggestedUrl);
          showToast(`SMTP helper server detected on port ${port}!`, "warning");
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
    const isDraft = state.settings.method === "localserver_draft";
    actionEl.textContent = isDraft ? "IMAP Drafts" : "SMTP Send";
  }
}

// Test Connection for Specific Account
function testSenderAccountConnection(id) {
  const acc = state.settings.senderAccounts.find(a => a.id === id);
  if (!acc) return;

  const testEmail = document.getElementById("global-test-email").value.trim() || acc.user;
  showToast(`Testing connection for ${acc.label}...`, "info");
  addLog(`[Local Server] Testing connection for account ${acc.label} (${acc.user}) using relay...`, "system");

  fetch(state.settings.localUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "send",
      host: acc.host,
      port: parseInt(acc.port),
      secure: acc.secure,
      user: acc.user,
      pass: acc.pass,
      senderEmail: acc.user,
      recipientEmail: testEmail,
      subject: "[Vesper Account Test] Connection Verification",
      body: `Success! Vesper SMTP Relay successfully verified your email account configurations:\n\nAccount: ${acc.label}\nUser: ${acc.user}\nHost: ${acc.host}:${acc.port}`
    })
  })
  .then(async (response) => {
    const data = await response.json();
    if (response.ok && data.success) {
      showToast(`Account ${acc.label} connected successfully!`, "success");
      addLog(`[Test Success] Account ${acc.label} authenticated and sent test email.`, "success");
    } else {
      showToast(`Connection failed: ${data.message || 'SMTP Handshake Error'}`, "error");
      addLog(`[Test Fail] Account ${acc.label} connection error: ${data.message}`, "error");
    }
  })
  .catch(err => {
    showToast(`Relay Connection Failed. Ensure local server script is running.`, "error");
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
  if (headers.length < 9) return;
  
  headers[1].innerHTML = `Name ${mappings.name ? `<span class="badge badge-indigo" style="margin-left:5px;">Col ${mappings.name}</span>` : ""}`;
  headers[2].innerHTML = `Email ${mappings.email ? `<span class="badge badge-indigo" style="margin-left:5px;">Col ${mappings.email}</span>` : ""}`;
  headers[3].innerHTML = `Affiliation ${mappings.aff ? `<span class="badge badge-outline-gray" style="margin-left:5px;">Col ${mappings.aff}</span>` : ""}`;
  headers[4].innerHTML = `Date ${mappings.date ? `<span class="badge badge-outline-gray" style="margin-left:5px;">Col ${mappings.date}</span>` : ""}`;
  headers[5].innerHTML = `Session / Tech Schedule ${mappings.session ? `<span class="badge badge-outline-yellow" style="margin-left:5px;">Col ${mappings.session}</span>` : ""}`;
  headers[6].innerHTML = `Time ${mappings.time ? `<span class="badge badge-outline-gray" style="margin-left:5px;">Col ${mappings.time}</span>` : ""}`;
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
  
  updateComposeReadOnlyConfig();
  updateLivePreview();
}

function createNewTemplate() {
  const name = prompt("Enter a name for the new template:", "New Template");
  if (!name || !name.trim()) return;
  
  const id = `template-${Date.now()}`;
  const newT = {
    id: id,
    name: name.trim(),
    subject: "Quick question regarding {Affiliation}",
    cc: "",
    bcc: "",
    body: "Hi {Name},\n\nThis is your custom template body.",
    senderAccountId: "",
    action: "send"
  };
  
  state.templates.push(newT);
  localStorage.setItem("vesper_templates", JSON.stringify(state.templates));
  
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  handleTemplateChange(id);
  showToast(`Created template: ${name.trim()}`, "success");
  
  // Refresh queue details and dropdown lists
  renderQueueTable();
}

function renameTemplate() {
  const t = state.templates.find(temp => temp.id === state.activeTemplateId);
  if (!t) return;
  
  const newName = prompt(`Rename template "${t.name}" to:`, t.name);
  if (!newName || !newName.trim()) return;
  
  t.name = newName.trim();
  localStorage.setItem("vesper_templates", JSON.stringify(state.templates));
  
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
  localStorage.setItem("vesper_templates", JSON.stringify(state.templates));
  
  // Switch to the first template
  const newActiveId = state.templates[0].id;
  populateTemplateSelector();
  populatePreviewTemplateSelector();
  handleTemplateChange(newActiveId);
  
  showToast(`Deleted template: ${t.name}`, "info");
  
  // Refresh queue details and dropdown lists
  renderQueueTable();
}
