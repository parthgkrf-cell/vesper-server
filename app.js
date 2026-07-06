/* -------------------------------------------------------------
 * VESPER MAIL SCHEDULER — CORE ENGINE & UI LOGIC
 * ------------------------------------------------------------- */

// State Object
let state = {
  recipients: [],
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
  logs: [],
  headers: {} // Map of column letters to header labels
};

// Global Timer Reference
let schedulerInterval = null;

// Initialize Application on Page Load
document.addEventListener("DOMContentLoaded", async () => {
  // Load cached theme and apply it immediately
  const cachedTheme = localStorage.getItem("vesper_theme") || "dark";
  document.documentElement.setAttribute("data-theme", cachedTheme);
  
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
  
  // Sync the theme button icon
  updateThemeToggleIcon(cachedTheme);
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
        if (config.template) {
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

  const cachedTemplate = localStorage.getItem("vesper_template");
  if (cachedTemplate) {
    try {
      state.template = { ...state.template, ...JSON.parse(cachedTemplate) };
    } catch (e) {
      console.error("Error loading cached template:", e);
    }
  }

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
  // Theme Toggle Button
  const themeBtn = document.getElementById("theme-toggle-btn");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
      const newTheme = currentTheme === "dark" ? "light" : "dark";
      
      document.documentElement.setAttribute("data-theme", newTheme);
      localStorage.setItem("vesper_theme", newTheme);
      
      updateThemeToggleIcon(newTheme);
      addLog(`Theme changed to: ${newTheme} mode`, "system");
      showToast(`Switched to ${newTheme === 'dark' ? 'Dark' : 'Light'} Mode`, "success");
      
      // Update live preview in case text rendering styles need to re-align
      updateLivePreview();
    });
  }

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

  // File drag and drop
  const dropzone = document.getElementById("excel-dropzone");
  const fileInput = document.getElementById("excel-file-input");

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
      handleExcelFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleExcelFile(e.target.files[0]);
    }
  });

  // Clear list button
  document.getElementById("btn-clear-excel").addEventListener("click", () => {
    state.recipients = [];
    saveRecipientsToCache();
    
    document.getElementById("parsed-data-section").classList.add("hidden");
    document.getElementById("excel-preview-table").querySelector("tbody").innerHTML = "";
    updateSummaryStats();
    populateRecipientDropdown();
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
    subtitle.textContent = "Draft your personalized body and preview variables";
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
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = `console-line ${type}`;
  line.textContent = `[${time}] ${message}`;
  
  consoleLogs.appendChild(line);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Parse dates/times from spreadsheets
function parseScheduleTime(val) {
  if (!val) return null;
  
  // If it's already a JS Date object
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val;
  }

  // Handle Excel Serial Date Number
  if (typeof val === "number") {
    // Excel base date is Dec 30 1899, not Jan 1 1900 because Excel incorrectly treats 1900 as a leap year
    const baseDate = new Date(1899, 11, 30);
    const dateVal = new Date(baseDate.getTime() + val * 24 * 60 * 60 * 1000);
    return isNaN(dateVal.getTime()) ? null : dateVal;
  }

  // Handle Strings
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "") return null;

    // First try standard parsing (covers ISO dates, standard date-time formats)
    let parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      // Check if it parsed standard dates like "2026-06-26 15:30:00"
      return parsed;
    }

    // Try parsing HH:MM or HH:MM AM/PM (relative to current day)
    const today = new Date();
    // Match 12-hour or 24-hour patterns
    const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
      const ampm = timeMatch[4];

      if (ampm) {
        if (ampm.toUpperCase() === "PM" && hours < 12) hours += 12;
        if (ampm.toUpperCase() === "AM" && hours === 12) hours = 0;
      }

      today.setHours(hours, minutes, seconds, 0);

      // If the time has already passed today, push it to tomorrow
      if (today.getTime() < Date.now()) {
        today.setDate(today.getDate() + 1);
      }
      return today;
    }

    // Match full date paths like "7/1/2026 6:26:07 PM" or "26/06/2026 15:30" (DD/MM/YYYY or MM/DD/YYYY)
    const dateMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (dateMatch) {
      const p1 = parseInt(dateMatch[1]);
      const p2 = parseInt(dateMatch[2]);
      const year = parseInt(dateMatch[3]);
      let hours = parseInt(dateMatch[4]);
      const minutes = parseInt(dateMatch[5]);
      const seconds = dateMatch[6] ? parseInt(dateMatch[6]) : 0;
      const ampm = dateMatch[7];

      if (ampm) {
        if (ampm.toUpperCase() === "PM" && hours < 12) hours += 12;
        if (ampm.toUpperCase() === "AM" && hours === 12) hours = 0;
      }

      // Determine Month Index and Day
      // If p1 > 12, it must be D/M/YYYY
      // Otherwise, default to US format M/D/YYYY
      let monthIndex = p1 - 1;
      let day = p2;
      if (p1 > 12) {
        monthIndex = p2 - 1;
        day = p1;
      }

      const dateObj = new Date(year, monthIndex, day, hours, minutes, seconds);
      return isNaN(dateObj.getTime()) ? null : dateObj;
    }
  }

  return null;
}

// Handle imported spreadsheet parsing
function handleExcelFile(file) {
  const reader = new FileReader();
  
  addLog(`Reading file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`, "system");
  
  reader.onload = (e) => {
    try {
      const data = e.target.result;
      const workbook = XLSX.read(data, { type: "binary" }); // Removed cellDates: true to avoid timezone shifts
      
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      const rows = XLSX.utils.sheet_to_json(sheet, { header: "A", raw: false, defval: "" });
      
      if (rows.length === 0) {
        throw new Error("The selected Excel sheet contains no rows of data.");
      }

      processImportedRows(rows);
      showToast(`Imported ${state.recipients.length} recipients!`, "success");
      
    } catch (err) {
      console.error(err);
      showToast(err.message, "error");
      addLog(`Failed to parse spreadsheet: ${err.message}`, "error");
    }
  };

  reader.onerror = () => {
    showToast("File reading error.", "error");
    addLog("FileReader encounter an error reading the file.", "error");
  };

  reader.readAsBinaryString(file);
}

// Clean and map imported columns to standardized format
function processImportedRows(rows) {
  state.recipients = [];
  state.headers = {};

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
  
  // Save to state.headers
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
  const actionCol = getColumnLetter(headerRow, ["Action", "Type", "Method", "Mode", "Scheduling Action"]);
  const sTimeCol = getColumnLetter(headerRow, ["S_Time", "S-Time", "STime", "S Time", "Schedule Time", "Send Time", "Schedule"]);

  let rowCounter = 0;
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
    const senderEmailStr = senderCol ? String(row[senderCol]).trim().toLowerCase() : "";
    const actionStr = actionCol ? String(row[actionCol]).trim().toLowerCase() : "";
    const rawSTime = sTimeCol ? row[sTimeCol] : "";

    // Require Name and Email
    if (!name || !email) {
      invalidCounter++;
      continue;
    }

    const parsedTime = parseScheduleTime(rawSTime);
    rowCounter++;

    // Match sender account
    let matchedAcc = null;
    if (senderEmailStr && state.settings.senderAccounts) {
      matchedAcc = state.settings.senderAccounts.find(acc => 
        acc.user.toLowerCase() === senderEmailStr || 
        acc.label.toLowerCase() === senderEmailStr
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
      id: `recipient-${rowCounter}-${Date.now()}`,
      name: name,
      email: email,
      affiliation: affiliation,
      date: date,
      techScheduleName: techScheduleName,
      session: techScheduleName,
      time: time,
      rawTime: String(rawSTime || "Now"),
      parsedTime: parsedTime || new Date(),
      senderAccountId: senderAccountId,
      sender: senderEmailStr || (matchedAcc ? matchedAcc.user : ""),
      action: action,
      cc: cc || state.template.cc || "",
      bcc: bcc || state.template.bcc || "",
      status: "Pending",
      colValues: colValues
    });
  }

  saveRecipientsToCache();
  
  // Show imported sections
  document.getElementById("parsed-data-section").classList.remove("hidden");
  
  // Update views
  renderExcelTable();
  updateSummaryStats();
  populateRecipientDropdown();
  renderQueueTable();

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
  
  addLog(`Successfully processed ${state.recipients.length} rows. Discarded ${invalidCounter} incomplete rows.`, "system");
}

// Render imported rows in the upload panel
function renderExcelTable() {
  const tbody = document.getElementById("excel-preview-table").querySelector("tbody");
  tbody.innerHTML = "";

  state.recipients.forEach((rec, idx) => {
    const row = document.createElement("tr");
    
    const displayTime = rec.parsedTime 
      ? rec.parsedTime.toLocaleString() 
      : `<span class="text-coral">Immediate</span>`;

    row.innerHTML = `
      <td>${idx + 1}</td>
      <td class="text-bold">${escapeHtml(rec.name)}</td>
      <td class="text-teal">${escapeHtml(rec.email)}</td>
      <td>${escapeHtml(rec.affiliation)}</td>
      <td>${escapeHtml(rec.date || "—")}</td>
      <td>${escapeHtml(rec.techScheduleName || "—")}</td>
      <td>${escapeHtml(rec.time || "—")}</td>
      <td><code>${escapeHtml(rec.rawTime || "Now")}</code></td>
      <td>${displayTime}</td>
    `;
    tbody.appendChild(row);
  });
}

// Render the active queue in the Queue manager panel
function renderQueueTable() {
  const tbody = document.getElementById("queue-details-table").querySelector("tbody");
  tbody.innerHTML = "";

  if (state.recipients.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="text-center text-muted">No emails loaded in the schedule queue yet. Import an Excel file first.</td>
      </tr>
    `;
    return;
  }

  state.recipients.forEach(rec => {
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

  lucide.createIcons();
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
    return `<span class="badge badge-outline-red" title="Error: ${error || 'Unknown'}">Failed</span>`;
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
  
  let text = templateStr;
  const replaceTag = (tag, val) => {
    const escapedTag = tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escapedTag, 'gi');
    text = text.replace(regex, val || "");
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

  return text;
}

// Render Live Preview Card
function updateLivePreview() {
  const dropdown = document.getElementById("preview-recipient-dropdown");
  const selectedId = dropdown.value;
  
  const rec = state.recipients.find(r => r.id === selectedId);
  
  // Header details display
  const accId = rec ? rec.senderAccountId : state.template.senderAccountId;
  const acc = (state.settings.senderAccounts || []).find(a => a.id === accId) || (state.settings.senderAccounts || []).find(a => a.isDefault);
  document.getElementById("preview-sender-display").innerHTML = acc
    ? `${escapeHtml(acc.label)} &lt;${escapeHtml(acc.user)}&gt;`
    : `No Sender Account Configured`;

  const ccVal = rec ? (rec.cc || state.template.cc || "") : (state.template.cc || "");
  const bccVal = rec ? (rec.bcc || state.template.bcc || "") : (state.template.bcc || "");

  const ccRow = document.getElementById("preview-cc-row");
  const ccDisplay = document.getElementById("preview-cc-display");
  if (ccRow && ccDisplay) {
    if (ccVal) {
      ccRow.classList.remove("hidden");
      ccDisplay.textContent = ccVal;
    } else {
      ccRow.classList.add("hidden");
    }
  }

  const bccRow = document.getElementById("preview-bcc-row");
  const bccDisplay = document.getElementById("preview-bcc-display");
  if (bccRow && bccDisplay) {
    if (bccVal) {
      bccRow.classList.remove("hidden");
      bccDisplay.textContent = bccVal;
    } else {
      bccRow.classList.add("hidden");
    }
  }

  if (!rec) {
    document.getElementById("preview-to-display").textContent = "recipient@domain.com";
    document.getElementById("preview-subject-display").textContent = state.template.subject || "No Subject";
    document.getElementById("preview-time-display").textContent = "Immediate";
    
    const bodyTemplate = state.template.body || "Compose template body...";
    document.getElementById("preview-body-display").innerHTML = bodyTemplate;
    return;
  }

  const subject = renderTemplate(state.template.subject, rec);
  const body = renderTemplate(state.template.body, rec);

  document.getElementById("preview-to-display").textContent = `${rec.name} <${rec.email}>`;
  document.getElementById("preview-subject-display").textContent = subject || "(No Subject)";
  document.getElementById("preview-time-display").textContent = rec.parsedTime ? rec.parsedTime.toLocaleString() : "Immediate";
  
  // Format body for display in preview
  document.getElementById("preview-body-display").innerHTML = body;
}

// Start Engine
function startSchedulerEngine() {
  if (state.schedulerActive) return;

  state.schedulerActive = true;
  updateSchedulerUIState();
  addLog("Scheduler Engine Started. Processing active queue...", "success");
  showToast("Scheduler Engine Started!", "success");

  // Run immediately and then hook interval check
  processSchedulerStep();
  schedulerInterval = setInterval(processSchedulerStep, 1000);
}

// Stop Engine
function stopSchedulerEngine() {
  if (!state.schedulerActive) return;

  state.schedulerActive = false;
  updateSchedulerUIState();
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  addLog("Scheduler Engine Paused.", "warning");
  showToast("Scheduler Engine Paused", "warning");
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

// Send actual email trigger
function dispatchEmail(rec) {
  rec.status = "Sending";
  updateRecStatusUI(rec);
  updateSummaryStats();

  const subject = renderTemplate(state.template.subject, rec);
  const body = renderTemplate(state.template.body, rec);

  const accId = rec.senderAccountId || state.template.senderAccountId;
  const acc = (state.settings.senderAccounts || []).find(a => a.id === accId) || (state.settings.senderAccounts || []).find(a => a.isDefault);

  if (!acc) {
    failDispatch(rec, "No SMTP sender account configured/matched for this job. Go to Configuration.");
    return;
  }

  const isDraft = rec.action === "draft";
  const logAction = isDraft ? "draft upload" : "SMTP transaction";
  addLog(`[Local Server] Routing ${logAction} for ${rec.name} using account ${acc.label} (${acc.user})...`, "system");

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
      senderEmail: acc.user,
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

// Generate sample excel spreadsheet downloader
function downloadSampleExcel() {
  try {
    const now = new Date();
    // Generate scheduled times for templates
    const t1 = new Date(now.getTime() + 5 * 60 * 1000); // 5 mins later
    const t2 = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins later
    const t3 = new Date(now.getTime() + 60 * 60 * 1000); // 1 hr later

    const formatTime = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      const sec = String(d.getSeconds()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
    };

    const data = [
      ["Name", "Email", "Affiliation", "Date", "Technical Schedual Name", "Time", "CC", "BCC", "Sender", "Action", "S_Time"],
      ["Devin Allen", "devin@example.com", "Acme Corporation", "2026-07-15", "Routine Maintenance", "10:00 AM", "manager@acme.com", "", "sender1@gmail.com", "send", formatTime(t1)],
      ["Elena Rostova", "elena@example.com", "Apex Labs", "2026-07-16", "Database Upgrade", "02:30 PM", "", "", "sender2@gmail.com", "draft", formatTime(t2)],
      ["Dr. Marcus Vance", "marcus@example.com", "Stanford University", "2026-07-17", "Server Deployment", "11:15 AM", "admin@stanford.edu", "archive@stanford.edu", "", "send", formatTime(t3)],
      ["Sarah Jenkins", "sarah@example.com", "Freelance", "2026-07-18", "API Integration", "04:30 PM", "", "", "", "draft", "04:30 PM"]
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Recipients");

    XLSX.writeFile(workbook, "vesper_scheduler_template.xlsx");
    showToast("Downloaded sample Excel template!", "success");
    addLog("Generated and downloaded sample Excel workbook.", "system");

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

// Sync the theme button icon based on active theme
function updateThemeToggleIcon(theme) {
  const btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  if (theme === "dark") {
    btn.innerHTML = `<i data-lucide="sun"></i>`;
  } else {
    btn.innerHTML = `<i data-lucide="moon"></i>`;
  }
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
