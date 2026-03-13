document.addEventListener("DOMContentLoaded", () => {
  const profileNameInput = document.getElementById("profileName");
  const currentSiteValue = document.getElementById("currentSiteValue");
  const saveSessionButton = document.getElementById("saveSessionButton");
  const profilesList = document.getElementById("profilesList");
  const statusMessage = document.getElementById("statusMessage");

  const STORAGE_KEY = "profiles";
  const PROFILE_NAME_REQUIRED_MESSAGE = "Profile name is required.";
  const INVALID_DOMAIN_MESSAGE = "Enter a valid domain.";
  const UNSUPPORTED_PAGE_MESSAGE = "Open an http:// or https:// page to use this extension.";
  const CURRENT_SITE_UNAVAILABLE_MESSAGE = "Current site unavailable.";

  let statusTimeoutId;
  let allProfiles = [];
  let currentProfiles = [];
  let busyState = null;
  let currentDomain = "";
  let currentDomainErrorMessage = "";
  let currentView = "list";
  let selectedProfileId = "";
  let expandedValueRows = new Set();
  let editingLocalStorageEntry = null;

  function showStatus(message, type = "info") {
    window.clearTimeout(statusTimeoutId);
    statusMessage.textContent = message;
    statusMessage.className = `status-message is-visible status-message--${type}`;

    statusTimeoutId = window.setTimeout(() => {
      statusMessage.textContent = "";
      statusMessage.className = "status-message";
    }, 1800);
  }

  function isProfileActionBusy(action, profileId) {
    return Boolean(
      busyState &&
        busyState.scope === "profile" &&
        busyState.action === action &&
        busyState.profileId === profileId
    );
  }

  function applyBusyState() {
    const isBusy = Boolean(busyState);

    saveSessionButton.disabled = isBusy || !currentDomain;
    saveSessionButton.textContent =
      busyState && busyState.scope === "save" ? "Saving..." : "Save current session";
    profileNameInput.disabled = isBusy;
    renderProfiles(allProfiles);
  }

  function setBusyState(nextBusyState) {
    busyState = nextBusyState;
    applyBusyState();
  }

  function setCurrentView(view, profileId = "") {
    currentView = view;
    selectedProfileId = profileId;
    expandedValueRows = new Set();
    editingLocalStorageEntry = null;
    renderProfiles(allProfiles);
  }

  function getRuntimeError() {
    return chrome.runtime.lastError
      ? new Error(chrome.runtime.lastError.message)
      : null;
  }

  function readProfilesFromStorage() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          reject(runtimeError);
          return;
        }

        resolve(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
      });
    });
  }

  function writeProfilesToStorage(profiles) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: profiles }, () => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          reject(runtimeError);
          return;
        }

        resolve();
      });
    });
  }

  function validateProfileName(input) {
    const trimmedValue = input.trim();

    if (!trimmedValue) {
      throw new Error(PROFILE_NAME_REQUIRED_MESSAGE);
    }

    return trimmedValue;
  }

  function normalizeCookieDomain(input) {
    const trimmedValue = input.trim().toLowerCase();

    if (!trimmedValue) {
      throw new Error(CURRENT_SITE_UNAVAILABLE_MESSAGE);
    }

    const candidateValue = /^[a-z]+:\/\//i.test(trimmedValue)
      ? trimmedValue
      : `https://${trimmedValue.replace(/^\/+/, "")}`;

    let normalizedHost = "";

    try {
      normalizedHost = new URL(candidateValue).hostname.toLowerCase();
    } catch (error) {
      throw new Error(INVALID_DOMAIN_MESSAGE);
    }

    normalizedHost = normalizedHost.replace(/^\.+/, "").replace(/\.+$/, "");

    if (
      !normalizedHost ||
      normalizedHost.length > 253 ||
      normalizedHost.includes("..") ||
      !/^[a-z0-9.-]+$/.test(normalizedHost)
    ) {
      throw new Error(INVALID_DOMAIN_MESSAGE);
    }

    const labels = normalizedHost.split(".");
    const hasInvalidLabel = labels.some((label) => {
      return !label || label.length > 63 || label.startsWith("-") || label.endsWith("-");
    });

    if (hasInvalidLabel) {
      throw new Error(INVALID_DOMAIN_MESSAGE);
    }

    return normalizedHost;
  }

  function readCookiesForDomain(domainInputValue) {
    return new Promise((resolve, reject) => {
      let normalizedDomain;

      try {
        normalizedDomain = normalizeCookieDomain(domainInputValue);
      } catch (error) {
        reject(error);
        return;
      }

      chrome.cookies.getAll({ domain: normalizedDomain }, (cookies) => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          reject(runtimeError);
          return;
        }

        resolve({
          normalizedDomain,
          cookies: Array.isArray(cookies) ? cookies : []
        });
      });
    });
  }

  function readAllCookies() {
    return new Promise((resolve, reject) => {
      chrome.cookies.getAll({}, (cookies) => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          reject(runtimeError);
          return;
        }

        resolve(Array.isArray(cookies) ? cookies : []);
      });
    });
  }

  async function readCookiesForProfileScope(profileDomain, activeTabHostname) {
    const normalizedProfileDomain = normalizeCookieDomain(profileDomain);
    const normalizedActiveHostname = normalizeCookieDomain(activeTabHostname);
    const allCookies = await readAllCookies();
    const scopedCookies = allCookies.filter((cookie) => {
      try {
        const cookieHostname = getCookieHostname(cookie, normalizedProfileDomain);

        return (
          domainsBelongToSameScope(cookieHostname, normalizedProfileDomain) ||
          domainsBelongToSameScope(cookieHostname, normalizedActiveHostname)
        );
      } catch (error) {
        console.debug("Skipping cookie during save scope build", error);
        return false;
      }
    });

    return {
      normalizedDomain: normalizedProfileDomain,
      cookies: scopedCookies
    };
  }

  function getCurrentActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          reject(runtimeError);
          return;
        }

        const [activeTab] = Array.isArray(tabs) ? tabs : [];

        if (!activeTab || typeof activeTab.id !== "number") {
          reject(new Error("No active tab found."));
          return;
        }

        resolve(activeTab);
      });
    });
  }

  function getActiveTabUrlContext(activeTab) {
    if (!activeTab || !activeTab.url) {
      throw new Error("The active tab does not have a readable URL.");
    }

    try {
      const parsedUrl = new URL(activeTab.url);

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(UNSUPPORTED_PAGE_MESSAGE);
      }

      return {
        url: activeTab.url,
        origin: parsedUrl.origin,
        hostname: normalizeCookieDomain(parsedUrl.hostname)
      };
    } catch (error) {
      if (error instanceof Error && error.message === UNSUPPORTED_PAGE_MESSAGE) {
        throw error;
      }

      throw new Error("The active tab does not have a readable URL.");
    }
  }

  async function getCurrentSiteHostname() {
    const activeTab = await getCurrentActiveTab();
    const activeTabContext = getActiveTabUrlContext(activeTab);
    return normalizeCookieDomain(activeTabContext.hostname);
  }

  function setCurrentDomainState(nextDomain, errorMessage = "") {
    currentDomain = nextDomain;
    currentDomainErrorMessage = errorMessage;
    currentSiteValue.textContent = nextDomain || errorMessage || "Current site unavailable.";
    currentSiteValue.className = nextDomain
      ? "field__readonly-value"
      : "field__readonly-value field__readonly-value--muted";
    renderProfiles(allProfiles);
  }

  async function refreshCurrentDomain({ showError = false } = {}) {
    try {
      const detectedDomain = await getCurrentSiteHostname();
      setCurrentDomainState(detectedDomain, "");
      return detectedDomain;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not read the current site domain.";

      setCurrentDomainState("", message);

      if (showError) {
        showStatus(message, "error");
      }

      return "";
    }
  }

  function domainsMatch(savedProfileDomain, activeTabHostname) {
    const normalizedSavedDomain = normalizeCookieDomain(savedProfileDomain);
    const normalizedActiveHostname = normalizeCookieDomain(activeTabHostname);

    return (
      normalizedSavedDomain === normalizedActiveHostname ||
      normalizedActiveHostname.endsWith(`.${normalizedSavedDomain}`)
    );
  }

  function normalizeDomainForComparison(input) {
    if (typeof input !== "string") {
      return "";
    }

    let normalizedValue = input.trim().toLowerCase();

    if (!normalizedValue) {
      return "";
    }

    try {
      const candidateValue = /^[a-z]+:\/\//i.test(normalizedValue)
        ? normalizedValue
        : `https://${normalizedValue.replace(/^\/+/, "")}`;

      normalizedValue = new URL(candidateValue).hostname.toLowerCase();
    } catch (error) {
      normalizedValue = normalizedValue.replace(/^[a-z]+:\/\//i, "");
      normalizedValue = normalizedValue.split("/")[0];
      normalizedValue = normalizedValue.split("?")[0];
      normalizedValue = normalizedValue.split("#")[0];
      normalizedValue = normalizedValue.split(":")[0];
    }

    return normalizedValue.replace(/^\.+/, "").replace(/\.+$/, "");
  }

  function isDomainFilterMatch(profileDomain, selectedDomain) {
    const normalizedProfileDomain = normalizeDomainForComparison(profileDomain);
    const normalizedSelectedDomain = normalizeDomainForComparison(selectedDomain);

    if (!normalizedSelectedDomain) {
      return true;
    }

    if (!normalizedProfileDomain) {
      return false;
    }

    return (
      normalizedProfileDomain === normalizedSelectedDomain ||
      normalizedProfileDomain.endsWith(`.${normalizedSelectedDomain}`) ||
      normalizedSelectedDomain.endsWith(`.${normalizedProfileDomain}`)
    );
  }

  function filterProfilesByDomain(profiles, selectedDomain) {
    const profileList = Array.isArray(profiles) ? profiles : [];

    if (!normalizeDomainForComparison(selectedDomain)) {
      return profileList;
    }

    return profileList.filter((profile) => isDomainFilterMatch(profile.domain, selectedDomain));
  }

  function profileHasStoredLocalStorage(profile) {
    return Boolean(
      profile &&
        profile.localStorage &&
        typeof profile.localStorage === "object" &&
        Object.keys(profile.localStorage).length > 0
    );
  }

  async function validateActivation(profile) {
    const activeTab = await getCurrentActiveTab();
    const activeTabContext = getActiveTabUrlContext(activeTab);

    if (!domainsMatch(profile.domain, activeTabContext.hostname)) {
      return {
        canActivate: false,
        message: `Domain mismatch: saved for ${profile.domain}, active tab is ${activeTabContext.hostname}.`,
        type: "error"
      };
    }

    if (
      profileHasStoredLocalStorage(profile) &&
      typeof profile.activeTabOrigin === "string" &&
      profile.activeTabOrigin &&
      profile.activeTabOrigin !== activeTabContext.origin
    ) {
      return {
        canActivate: false,
        message: `Origin mismatch: saved for ${profile.activeTabOrigin}, active tab is ${activeTabContext.origin}.`,
        type: "error"
      };
    }

    return {
      canActivate: true,
      message: `Validation passed for ${profile.profileName}. Activation can proceed.`,
      type: "success",
      activeTab,
      activeTabContext
    };
  }

  function getCookieHostname(cookie, fallbackHostname) {
    const normalizedFallbackHost = normalizeCookieDomain(fallbackHostname);
    const cookieDomain =
      typeof cookie.domain === "string" && cookie.domain.trim()
        ? cookie.domain.replace(/^\.+/, "")
        : normalizedFallbackHost;

    return cookieDomain;
  }

  function domainsBelongToSameScope(firstDomain, secondDomain) {
    const normalizedFirstDomain = normalizeCookieDomain(firstDomain);
    const normalizedSecondDomain = normalizeCookieDomain(secondDomain);

    return (
      normalizedFirstDomain === normalizedSecondDomain ||
      normalizedFirstDomain.endsWith(`.${normalizedSecondDomain}`) ||
      normalizedSecondDomain.endsWith(`.${normalizedFirstDomain}`)
    );
  }

  function buildCookieUrl(cookie, fallbackHostname) {
    const cookieDomain = getCookieHostname(cookie, fallbackHostname);
    const protocol = cookie.secure ? "https:" : "http:";
    const path = typeof cookie.path === "string" && cookie.path ? cookie.path : "/";

    return `${protocol}//${cookieDomain}${path}`;
  }

  function removeCookie(cookie, fallbackHostname) {
    return new Promise((resolve) => {
      chrome.cookies.remove(
        {
          url: buildCookieUrl(cookie, fallbackHostname),
          name: cookie.name,
          storeId: cookie.storeId
        },
        (details) => {
          const runtimeError = getRuntimeError();

          if (runtimeError) {
            resolve({
              removed: false,
              error: runtimeError
            });
            return;
          }

          resolve({
            removed: Boolean(details)
          });
        }
      );
    });
  }

  async function clearCookiesForProfile(profile, activeTabHostname) {
    const scopeDomains = new Set();
    const normalizedProfileDomain = normalizeCookieDomain(profile.domain);
    const normalizedActiveHostname = normalizeCookieDomain(activeTabHostname);
    const savedCookies = Array.isArray(profile.cookies) ? profile.cookies : [];
    const allCookies = await readAllCookies();

    scopeDomains.add(normalizedProfileDomain);
    scopeDomains.add(normalizedActiveHostname);

    savedCookies.forEach((cookie) => {
      try {
        scopeDomains.add(getCookieHostname(cookie, normalizedProfileDomain));
      } catch (error) {
        console.debug("Skipping saved cookie domain during clear scope build", error);
      }
    });

    const cookiesToRemove = allCookies.filter((cookie) => {
      try {
        const cookieHostname = getCookieHostname(cookie, normalizedProfileDomain);

        return Array.from(scopeDomains).some((scopeDomain) =>
          domainsBelongToSameScope(cookieHostname, scopeDomain)
        );
      } catch (error) {
        console.debug("Skipping cookie during clear", error);
        return false;
      }
    });

    const removalResults = await Promise.all(
      cookiesToRemove.map((cookie) => removeCookie(cookie, normalizedProfileDomain))
    );

    return {
      attempted: cookiesToRemove.length,
      removed: removalResults.filter((result) => result.removed).length,
      failed: removalResults.filter((result) => result.error).length
    };
  }

  function restoreCookie(cookie, fallbackHostname) {
    return new Promise((resolve) => {
      const cookieHostname = getCookieHostname(cookie, fallbackHostname);
      const details = {
        url: buildCookieUrl(
          {
            ...cookie,
            domain: cookie.hostOnly ? cookieHostname : cookie.domain
          },
          fallbackHostname
        ),
        name: cookie.name,
        value: typeof cookie.value === "string" ? cookie.value : "",
        path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly)
      };

      // Keep host-only cookies host-only so login/logout logic on the site still behaves as saved.
      if (!cookie.hostOnly && typeof cookie.domain === "string" && cookie.domain.trim()) {
        details.domain = cookie.domain;
      }

      if (typeof cookie.sameSite === "string" && cookie.sameSite) {
        details.sameSite = cookie.sameSite;
      }

      if (!cookie.session && typeof cookie.expirationDate === "number") {
        details.expirationDate = cookie.expirationDate;
      }

      if (typeof cookie.storeId === "string" && cookie.storeId) {
        details.storeId = cookie.storeId;
      }

      chrome.cookies.set(details, (createdCookie) => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          resolve({
            restored: false,
            error: runtimeError
          });
          return;
        }

        if (!createdCookie) {
          resolve({
            restored: false,
            error: new Error(`Chrome did not return a cookie for ${cookie.name}.`)
          });
          return;
        }

        resolve({ restored: true });
      });
    });
  }

  async function restoreProfileCookies(profile, activeTabHostname) {
    const normalizedDomain = normalizeCookieDomain(profile.domain);
    const savedCookies = Array.isArray(profile.cookies) ? profile.cookies : [];

    await clearCookiesForProfile(profile, activeTabHostname);

    if (!savedCookies.length) {
      return {
        total: 0,
        restored: 0,
        failed: 0,
        failures: []
      };
    }

    const restoreResults = await Promise.all(
      savedCookies.map((cookie) => restoreCookie(cookie, normalizedDomain))
    );
    const failures = restoreResults
      .map((result, index) => ({ result, cookie: savedCookies[index] }))
      .filter(({ result }) => !result.restored)
      .map(({ result, cookie }) => ({
        cookieName: cookie.name,
        message: result.error ? result.error.message : "Unknown cookie restore error."
      }));

    return {
      total: savedCookies.length,
      restored: restoreResults.filter((result) => result.restored).length,
      failed: failures.length,
      failures
    };
  }

  function writeLocalStorageEntries(savedEntries) {
    const entries = savedEntries && typeof savedEntries === "object" ? savedEntries : {};
    const keys = Object.keys(entries);

    // localStorage belongs to one site origin at a time, so we clear and rebuild it for that tab.
    window.localStorage.clear();

    keys.forEach((key) => {
      const value = entries[key];
      window.localStorage.setItem(key, value === null ? "null" : String(value));
    });

    return {
      cleared: true,
      restored: keys.length
    };
  }

  function writeSessionStorageEntries(savedEntries) {
    const entries = savedEntries && typeof savedEntries === "object" ? savedEntries : {};
    const keys = Object.keys(entries);

    // sessionStorage survives a reload in the same tab, so we must clear stale auth state explicitly.
    window.sessionStorage.clear();

    keys.forEach((key) => {
      const value = entries[key];
      window.sessionStorage.setItem(key, value === null ? "null" : String(value));
    });

    return {
      cleared: true,
      restored: keys.length
    };
  }

  function collectLocalStorageEntries() {
    const entries = {};

    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);

      if (key === null) {
        continue;
      }

      entries[key] = window.localStorage.getItem(key);
    }

    return entries;
  }

  function collectSessionStorageEntries() {
    const entries = {};

    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);

      if (key === null) {
        continue;
      }

      entries[key] = window.sessionStorage.getItem(key);
    }

    return entries;
  }

  async function executeScriptInTab(activeTabId, func, args = []) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func,
        args
      });
      const [result] = Array.isArray(results) ? results : [];
      return result && typeof result.result !== "undefined" ? result.result : null;
    } catch (error) {
      throw new Error(error && error.message ? error.message : "Failed to run script in the tab.");
    }
  }

  async function restoreProfileLocalStorage(profile, activeTab) {
    if (!activeTab || typeof activeTab.id !== "number") {
      throw new Error("No active tab found.");
    }

    const savedLocalStorage =
      profile.localStorage && typeof profile.localStorage === "object" ? profile.localStorage : {};
    const result = await executeScriptInTab(activeTab.id, writeLocalStorageEntries, [
      savedLocalStorage
    ]);

    if (!result || typeof result !== "object") {
      return {
        cleared: false,
        restored: 0
      };
    }

    return result;
  }

  async function restoreProfileSessionStorage(profile, activeTab) {
    if (!activeTab || typeof activeTab.id !== "number") {
      throw new Error("No active tab found.");
    }

    const savedSessionStorage =
      profile.sessionStorage && typeof profile.sessionStorage === "object"
        ? profile.sessionStorage
        : {};
    const result = await executeScriptInTab(activeTab.id, writeSessionStorageEntries, [
      savedSessionStorage
    ]);

    if (!result || typeof result !== "object") {
      return {
        cleared: false,
        restored: 0
      };
    }

    return result;
  }

  async function readLocalStorageFromActiveTab() {
    const activeTab = await getCurrentActiveTab();
    const result = await executeScriptInTab(activeTab.id, collectLocalStorageEntries);
    return result && typeof result === "object" ? result : {};
  }

  async function readSessionStorageFromActiveTab() {
    const activeTab = await getCurrentActiveTab();
    const result = await executeScriptInTab(activeTab.id, collectSessionStorageEntries);
    return result && typeof result === "object" ? result : {};
  }

  function reloadTab(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.reload(tabId, {}, () => {
        const runtimeError = getRuntimeError();

        if (runtimeError) {
          reject(runtimeError);
          return;
        }

        resolve();
      });
    });
  }

  async function activateProfile(profile) {
    const validation = await validateActivation(profile);

    if (!validation.canActivate) {
      throw new Error(validation.message);
    }

    const cookieSummary = await restoreProfileCookies(profile, validation.activeTabContext.hostname);

    if (cookieSummary.failed > 0) {
      console.error("Some cookies failed to restore", cookieSummary.failures);
      throw new Error("Cookie restore incomplete.");
    }

    await restoreProfileLocalStorage(profile, validation.activeTab);
    await restoreProfileSessionStorage(profile, validation.activeTab);
    await reloadTab(validation.activeTab.id);
  }

  async function deleteProfile(profileId) {
    const profiles = await readProfilesFromStorage();
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId);

    await writeProfilesToStorage(nextProfiles);
    return nextProfiles;
  }

  function formatSavedAt(savedAt) {
    const parsedDate = new Date(savedAt);

    if (Number.isNaN(parsedDate.getTime())) {
      return "Unknown time";
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(parsedDate);
  }

  function getProfileCookieCount(profile) {
    return Array.isArray(profile.cookies) ? profile.cookies.length : 0;
  }

  function getProfileLocalStorageCount(profile) {
    if (!profile.localStorage || typeof profile.localStorage !== "object") {
      return 0;
    }

    return Object.keys(profile.localStorage).length;
  }

  function getProfileLocalStorageEntries(profile) {
    if (!profile.localStorage || typeof profile.localStorage !== "object") {
      return [];
    }

    return Object.entries(profile.localStorage);
  }

  function isEditingLocalStorageEntry(profileId, entryKey) {
    return Boolean(
      editingLocalStorageEntry &&
        editingLocalStorageEntry.profileId === profileId &&
        editingLocalStorageEntry.originalKey === entryKey
    );
  }

  function startEditingLocalStorageEntry(profileId, entryKey, entryValue) {
    editingLocalStorageEntry = {
      profileId,
      originalKey: entryKey,
      draftKey: entryKey,
      draftValue: typeof entryValue === "string" ? entryValue : entryValue === null ? "null" : ""
    };
    renderProfiles(allProfiles);
  }

  function cancelEditingLocalStorageEntry() {
    editingLocalStorageEntry = null;
    renderProfiles(allProfiles);
  }

  async function saveLocalStorageEntry(profileId) {
    if (!editingLocalStorageEntry || editingLocalStorageEntry.profileId !== profileId) {
      return;
    }

    const profiles = await readProfilesFromStorage();
    const profileIndex = profiles.findIndex((profile) => profile.id === profileId);

    if (profileIndex === -1) {
      throw new Error("Profile not found.");
    }

    const profile = profiles[profileIndex];
    const currentEntries = getProfileLocalStorageEntries(profile);
    const nextKey = editingLocalStorageEntry.draftKey;
    const nextValue = editingLocalStorageEntry.draftValue;
    const hasDuplicateKey = currentEntries.some(([existingKey]) => {
      return (
        existingKey === nextKey && existingKey !== editingLocalStorageEntry.originalKey
      );
    });

    if (hasDuplicateKey) {
      throw new Error("A localStorage entry with this key already exists.");
    }

    const nextLocalStorage = {};

    currentEntries.forEach(([existingKey, existingValue]) => {
      if (existingKey === editingLocalStorageEntry.originalKey) {
        nextLocalStorage[nextKey] = nextValue;
        return;
      }

      nextLocalStorage[existingKey] = existingValue;
    });

    const nextProfiles = [...profiles];
    nextProfiles[profileIndex] = {
      ...profile,
      localStorage: nextLocalStorage
    };

    await writeProfilesToStorage(nextProfiles);
    editingLocalStorageEntry = null;
    renderProfiles(nextProfiles);
  }

  function findProfileById(profileId) {
    return allProfiles.find((profile) => profile.id === profileId) || null;
  }

  function createIcon(iconName) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("button__icon");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-width", "1.8");

    if (iconName === "view") {
      path.setAttribute(
        "d",
        "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z"
      );
    } else if (iconName === "edit") {
      path.setAttribute(
        "d",
        "M12 20h9 M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
      );
    } else {
      path.setAttribute(
        "d",
        "M4.5 7.5h15 M9.5 3.75h5 M9 10.5v6 M15 10.5v6 M7.5 7.5l.75 11.25a1.5 1.5 0 0 0 1.5 1.4h4.5a1.5 1.5 0 0 0 1.5-1.4L16.5 7.5"
      );
    }

    icon.appendChild(path);
    return icon;
  }

  function createActionButton({
    label,
    busyLabel,
    variantClass,
    isBusy,
    onClick,
    iconName = "",
    title = ""
  }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${variantClass}`;
    button.disabled = Boolean(busyState);

    if (title) {
      button.title = title;
    }

    if (iconName) {
      button.setAttribute("aria-label", label);
      if (isBusy) {
        button.setAttribute("aria-busy", "true");
      }
      button.appendChild(createIcon(iconName));
    } else {
      button.textContent = isBusy ? busyLabel : label;
    }

    button.addEventListener("click", onClick);
    return button;
  }

  async function handleProfileAction({
    profile,
    action,
    beforeMessage,
    successMessage,
    failureMessage,
    run
  }) {
    if (busyState) {
      return;
    }

    setBusyState({
      scope: "profile",
      action,
      profileId: profile.id
    });
    showStatus(beforeMessage, "info");

    try {
      await run();
      showStatus(successMessage, "success");
    } catch (error) {
      console.error(`${action} failed`, error);
      showStatus(error instanceof Error ? error.message : failureMessage, "error");
    } finally {
      setBusyState(null);
    }
  }

  function renderEmptyProfilesState({ hasDomainFilter = false } = {}) {
    const emptyState = document.createElement("div");
    emptyState.className = "profiles-list__empty";

    const emptyTitle = document.createElement("p");
    emptyTitle.className = "profiles-list__empty-title";
    emptyTitle.textContent = hasDomainFilter
      ? "No saved profiles for this domain"
      : "No profiles saved yet";

    const emptyHint = document.createElement("p");
    emptyHint.className = "profiles-list__empty-hint";
    emptyHint.textContent = hasDomainFilter
      ? "Try another domain or save the current session for this site."
      : "Save the current tab session to create a reusable demo profile.";

    emptyState.append(emptyTitle, emptyHint);
    profilesList.appendChild(emptyState);
  }

  function renderCurrentSiteUnavailableState() {
    const emptyState = document.createElement("div");
    emptyState.className = "profiles-list__empty";

    const emptyTitle = document.createElement("p");
    emptyTitle.className = "profiles-list__empty-title";
    emptyTitle.textContent = "Current site unavailable";

    const emptyHint = document.createElement("p");
    emptyHint.className = "profiles-list__empty-hint";
    emptyHint.textContent =
      currentDomainErrorMessage || "Open an http:// or https:// page to view saved profiles.";

    emptyState.append(emptyTitle, emptyHint);
    profilesList.appendChild(emptyState);
  }

  function createDetailsItem(label, value) {
    const detailsItem = document.createElement("div");
    detailsItem.className = "profile-details__item";

    const detailsLabel = document.createElement("span");
    detailsLabel.className = "profile-details__label";
    detailsLabel.textContent = label;

    const detailsValue = document.createElement("strong");
    detailsValue.className = "profile-details__value";
    detailsValue.textContent = value;

    detailsItem.append(detailsLabel, detailsValue);
    return detailsItem;
  }

  function formatCookieExpiration(expirationDate) {
    if (typeof expirationDate !== "number" || Number.isNaN(expirationDate)) {
      return "Session cookie";
    }

    return formatSavedAt(new Date(expirationDate * 1000).toISOString());
  }

  function formatCookieSameSite(sameSite) {
    if (typeof sameSite !== "string" || !sameSite) {
      return "Not set";
    }

    return sameSite;
  }

  function createCookieDetailRow(label, value, extraClassName = "") {
    const row = document.createElement("div");
    row.className = "cookie-item__row";

    const key = document.createElement("span");
    key.className = "cookie-item__key";
    key.textContent = label;

    const content = document.createElement("span");
    content.className = `cookie-item__value ${extraClassName}`.trim();
    content.textContent = value;

    row.append(key, content);
    return row;
  }

  function createExpandableValueRow({
    expansionKey,
    label = "Value",
    value,
    emptyValueLabel = "(empty)"
  }) {
    const normalizedValue = typeof value === "string" ? value : value === null ? "null" : "";
    const shouldShowToggle = normalizedValue.length > 120 || normalizedValue.includes("\n");
    const isExpanded = expandedValueRows.has(expansionKey);
    const row = document.createElement("div");
    row.className = "cookie-item__row cookie-item__row--stacked";

    const rowHeader = document.createElement("div");
    rowHeader.className = "cookie-item__row-header";

    const key = document.createElement("span");
    key.className = "cookie-item__key";
    key.textContent = label;
    rowHeader.appendChild(key);

    if (shouldShowToggle) {
      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "cookie-item__toggle";
      toggleButton.textContent = isExpanded ? "Collapse" : "Expand";
      toggleButton.setAttribute("aria-expanded", String(isExpanded));
      toggleButton.addEventListener("click", () => {
        if (expandedValueRows.has(expansionKey)) {
          expandedValueRows.delete(expansionKey);
        } else {
          expandedValueRows.add(expansionKey);
        }

        renderProfiles(allProfiles);
      });
      rowHeader.appendChild(toggleButton);
    }

    const content = document.createElement("pre");
    content.className = `cookie-item__value cookie-item__value--block${
      isExpanded ? " is-expanded" : ""
    }`;
    content.textContent = normalizedValue || emptyValueLabel;

    row.append(rowHeader, content);
    return row;
  }

  function createCookieValueRow({ profileId, cookie, cookieIndex }) {
    return createExpandableValueRow({
      expansionKey: `${profileId}:cookie:${cookieIndex}:${cookie.name}`,
      value: cookie.value
    });
  }

  function createLocalStorageEditor(profileId) {
    const editor = document.createElement("div");
    editor.className = "local-storage-editor";

    const keyField = document.createElement("label");
    keyField.className = "local-storage-editor__field";

    const keyLabel = document.createElement("span");
    keyLabel.className = "local-storage-editor__label";
    keyLabel.textContent = "Key";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "local-storage-editor__input";
    keyInput.value = editingLocalStorageEntry ? editingLocalStorageEntry.draftKey : "";
    keyInput.disabled = Boolean(busyState);
    keyInput.addEventListener("input", (event) => {
      if (!editingLocalStorageEntry) {
        return;
      }

      editingLocalStorageEntry.draftKey = event.target.value;
    });

    keyField.append(keyLabel, keyInput);

    const valueField = document.createElement("label");
    valueField.className = "local-storage-editor__field";

    const valueLabel = document.createElement("span");
    valueLabel.className = "local-storage-editor__label";
    valueLabel.textContent = "Value";

    const valueInput = document.createElement("textarea");
    valueInput.className = "local-storage-editor__textarea";
    valueInput.rows = 4;
    valueInput.value = editingLocalStorageEntry ? editingLocalStorageEntry.draftValue : "";
    valueInput.disabled = Boolean(busyState);
    valueInput.addEventListener("input", (event) => {
      if (!editingLocalStorageEntry) {
        return;
      }

      editingLocalStorageEntry.draftValue = event.target.value;
    });

    valueField.append(valueLabel, valueInput);

    const actions = document.createElement("div");
    actions.className = "local-storage-editor__actions";

    const saveButton = createActionButton({
      label: "Save",
      busyLabel: "Saving...",
      variantClass: "button--secondary button--compact",
      isBusy: isProfileActionBusy("edit-local-storage", profileId),
      onClick: async () => {
        if (!editingLocalStorageEntry) {
          return;
        }

        await handleProfileAction({
          profile: { id: profileId, profileName: "localStorage entry" },
          action: "edit-local-storage",
          beforeMessage: "Saving localStorage entry...",
          successMessage: "LocalStorage entry updated",
          failureMessage: "Failed to update localStorage entry.",
          run: () => saveLocalStorageEntry(profileId)
        });
      }
    });
    saveButton.disabled = Boolean(busyState);

    const cancelButton = createActionButton({
      label: "Cancel",
      busyLabel: "Cancel",
      variantClass: "button--ghost button--compact",
      isBusy: false,
      onClick: () => cancelEditingLocalStorageEntry()
    });
    cancelButton.disabled = Boolean(busyState);

    actions.append(saveButton, cancelButton);
    editor.append(keyField, valueField, actions);

    window.setTimeout(() => {
      keyInput.focus();
      keyInput.setSelectionRange(keyInput.value.length, keyInput.value.length);
    }, 0);

    return editor;
  }

  function renderCookiesSection(profile) {
    const section = document.createElement("section");
    section.className = "profile-details__section";

    const header = document.createElement("div");
    header.className = "profile-details__section-header";

    const title = document.createElement("h4");
    title.className = "profile-details__section-title";
    title.textContent = "Cookies";

    const count = document.createElement("span");
    count.className = "profile-details__section-count";
    count.textContent = `${getProfileCookieCount(profile)} saved`;

    header.append(title, count);
    section.appendChild(header);

    const cookies = Array.isArray(profile.cookies) ? profile.cookies : [];

    if (!cookies.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "cookie-empty-state";
      emptyState.textContent = "No cookies were saved for this profile.";
      section.appendChild(emptyState);
      return section;
    }

    const list = document.createElement("div");
    list.className = "cookie-list";

    cookies.forEach((cookie, cookieIndex) => {
      const item = document.createElement("article");
      item.className = "cookie-item";

      const itemTitle = document.createElement("h5");
      itemTitle.className = "cookie-item__title";
      itemTitle.textContent = cookie.name || "Unnamed cookie";

      const itemMeta = document.createElement("div");
      itemMeta.className = "cookie-item__meta";

      const secureBadge = document.createElement("span");
      secureBadge.className = "cookie-item__badge";
      secureBadge.textContent = cookie.secure ? "Secure" : "Not secure";

      const httpOnlyBadge = document.createElement("span");
      httpOnlyBadge.className = "cookie-item__badge";
      httpOnlyBadge.textContent = cookie.httpOnly ? "HttpOnly" : "Readable";

      itemMeta.append(secureBadge, httpOnlyBadge);
      item.append(itemTitle, itemMeta);

      item.append(
        createCookieValueRow({ profileId: profile.id, cookie, cookieIndex }),
        createCookieDetailRow("Domain", cookie.domain || profile.domain || "Unknown"),
        createCookieDetailRow("Path", cookie.path || "/"),
        createCookieDetailRow("Secure", cookie.secure ? "Yes" : "No"),
        createCookieDetailRow("HttpOnly", cookie.httpOnly ? "Yes" : "No"),
        createCookieDetailRow("SameSite", formatCookieSameSite(cookie.sameSite)),
        createCookieDetailRow("Expires", formatCookieExpiration(cookie.expirationDate))
      );

      list.appendChild(item);
    });

    section.appendChild(list);
    return section;
  }

  function renderLocalStorageSection(profile) {
    const section = document.createElement("section");
    section.className = "profile-details__section";

    const header = document.createElement("div");
    header.className = "profile-details__section-header";

    const title = document.createElement("h4");
    title.className = "profile-details__section-title";
    title.textContent = "Local Storage";

    const count = document.createElement("span");
    count.className = "profile-details__section-count";
    count.textContent = `${getProfileLocalStorageCount(profile)} saved`;

    header.append(title, count);
    section.appendChild(header);

    const entries = getProfileLocalStorageEntries(profile);

    if (!entries.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "cookie-empty-state";
      emptyState.textContent = "No localStorage entries were saved for this profile.";
      section.appendChild(emptyState);
      return section;
    }

    const list = document.createElement("div");
    list.className = "cookie-list";

    entries.forEach(([entryKey, entryValue], entryIndex) => {
      const item = document.createElement("article");
      item.className = "cookie-item";

      const keyRow = document.createElement("div");
      keyRow.className = "cookie-item__row";

      const keyLabel = document.createElement("span");
      keyLabel.className = "cookie-item__key";
      keyLabel.textContent = "Key";

      const keyContent = document.createElement("div");
      keyContent.className = "local-storage-entry__key-row";

      const keyValue = document.createElement("span");
      keyValue.className = "cookie-item__value";
      keyValue.textContent = entryKey || "(empty key)";

      const editButton = createActionButton({
        label: "Edit entry",
        busyLabel: "Edit entry",
        variantClass: "button--icon button--ghost button--icon-small",
        isBusy: false,
        iconName: "edit",
        title: "Edit localStorage entry",
        onClick: () => startEditingLocalStorageEntry(profile.id, entryKey, entryValue)
      });
      editButton.disabled = Boolean(
        busyState ||
          (editingLocalStorageEntry &&
            !isEditingLocalStorageEntry(profile.id, entryKey))
      );

      keyContent.append(keyValue, editButton);
      keyRow.append(keyLabel, keyContent);

      item.appendChild(keyRow);

      if (isEditingLocalStorageEntry(profile.id, entryKey)) {
        item.appendChild(createLocalStorageEditor(profile.id));
      } else {
        item.appendChild(
          createExpandableValueRow({
            expansionKey: `${profile.id}:localStorage:${entryIndex}:${entryKey}`,
            value: entryValue
          })
        );
      }

      list.appendChild(item);
    });

    section.appendChild(list);
    return section;
  }

  function renderProfileDetailsView(profile) {
    const detailsView = document.createElement("article");
    detailsView.className = "profile-details";

    const backButton = createActionButton({
      label: "Back",
      busyLabel: "Back",
      variantClass: "button--ghost button--inline",
      isBusy: false,
      onClick: () => setCurrentView("list")
    });
    backButton.disabled = false;

    const title = document.createElement("h3");
    title.className = "profile-details__title";
    title.textContent = profile.profileName;

    const subtitle = document.createElement("p");
    subtitle.className = "profile-details__subtitle";
    subtitle.textContent = "Saved session snapshot";

    const grid = document.createElement("div");
    grid.className = "profile-details__grid";
    grid.append(
      createDetailsItem("Profile name", profile.profileName),
      createDetailsItem("Domain", profile.domain || "Unknown domain"),
      createDetailsItem("Saved at", formatSavedAt(profile.savedAt)),
      createDetailsItem("Cookies", String(getProfileCookieCount(profile))),
      createDetailsItem("localStorage", String(getProfileLocalStorageCount(profile)))
    );

    detailsView.append(
      backButton,
      title,
      subtitle,
      grid,
      renderCookiesSection(profile),
      renderLocalStorageSection(profile)
    );
    profilesList.appendChild(detailsView);
  }

  function renderProfilesListView() {
    if (!currentProfiles.length) {
      renderEmptyProfilesState({
        hasDomainFilter: Boolean(normalizeDomainForComparison(currentDomain))
      });
      return;
    }

    const fragment = document.createDocumentFragment();

    currentProfiles.forEach((profile) => {
      const profileCard = document.createElement("article");
      profileCard.className = "profile-card";

      const profileTopRow = document.createElement("div");
      profileTopRow.className = "profile-card__top-row";

      const profileName = document.createElement("h3");
      profileName.className = "profile-card__title";
      profileName.textContent = profile.profileName;

      const profileDomain = document.createElement("p");
      profileDomain.className = "profile-card__domain";
      profileDomain.textContent = profile.domain;

      profileTopRow.append(profileName, profileDomain);

      const profileMetaRow = document.createElement("div");
      profileMetaRow.className = "profile-card__meta-row";

      const metaItems = [
        `Saved ${formatSavedAt(profile.savedAt)}`,
        `${getProfileCookieCount(profile)} cookies`,
        `${getProfileLocalStorageCount(profile)} localStorage`
      ];

      metaItems.forEach((text) => {
        const metaItem = document.createElement("span");
        metaItem.className = "profile-card__meta-item";
        metaItem.textContent = text;
        profileMetaRow.appendChild(metaItem);
      });

      const actions = document.createElement("div");
      actions.className = "profile-card__actions";

      const viewDetailsButton = createActionButton({
        label: "View details",
        busyLabel: "View details",
        variantClass: "button--icon button--ghost",
        isBusy: false,
        iconName: "view",
        title: "View details",
        onClick: () => setCurrentView("details", profile.id)
      });
      viewDetailsButton.disabled = Boolean(busyState);

      const activateButton = createActionButton({
        label: "Activate",
        busyLabel: "Activating...",
        variantClass: "button--secondary",
        isBusy: isProfileActionBusy("activate", profile.id),
        onClick: async () => {
          await handleProfileAction({
            profile,
            action: "activate",
            beforeMessage: `Activating ${profile.profileName}...`,
            successMessage: "Session activated successfully",
            failureMessage: "Failed to activate session",
            run: () => activateProfile(profile)
          });
        }
      });

      const deleteButton = createActionButton({
        label: "Delete",
        busyLabel: "Deleting...",
        variantClass: "button--icon button--ghost",
        isBusy: isProfileActionBusy("delete", profile.id),
        iconName: "delete",
        title: "Delete profile",
        onClick: async () => {
          if (!window.confirm(`Delete profile "${profile.profileName}"?`)) {
            return;
          }

          await handleProfileAction({
            profile,
            action: "delete",
            beforeMessage: `Deleting ${profile.profileName}...`,
            successMessage: "Profile deleted",
            failureMessage: "Failed to delete profile.",
            run: async () => {
              const profiles = await deleteProfile(profile.id);
              renderProfiles(profiles);
            }
          });
        }
      });

      actions.append(viewDetailsButton, activateButton, deleteButton);
      profileCard.append(profileTopRow, profileMetaRow, actions);
      fragment.appendChild(profileCard);
    });

    profilesList.appendChild(fragment);
  }

  function renderProfiles(profiles) {
    allProfiles = Array.isArray(profiles) ? profiles : [];
    currentProfiles = filterProfilesByDomain(allProfiles, currentDomain);
    profilesList.textContent = "";

    if (!currentDomain) {
      currentView = "list";
      selectedProfileId = "";
      renderCurrentSiteUnavailableState();
      return;
    }

    if (currentView === "details") {
      const selectedProfile = findProfileById(selectedProfileId);

      if (!selectedProfile || !isDomainFilterMatch(selectedProfile.domain, currentDomain)) {
        currentView = "list";
        selectedProfileId = "";
        renderProfilesListView();
        return;
      }

      renderProfileDetailsView(selectedProfile);
      return;
    }

    renderProfilesListView();
  }

  async function initializePopup() {
    try {
      const profiles = await readProfilesFromStorage();
      allProfiles = profiles;
    } catch (error) {
      console.error("Failed to load profiles", error);
      allProfiles = [];
      showStatus("Failed to load saved profiles.", "error");
    }

    await refreshCurrentDomain();
  }

  /**
   * This is the saved profile data kept in Chrome storage.
   * It is the full "session snapshot" we can re-apply later for demos or testing.
   */
  function createProfile({
    profileName,
    domain,
    cookies,
    localStorageEntries,
    sessionStorageEntries,
    activeTabUrl,
    activeTabOrigin
  }) {
    return {
      id: crypto.randomUUID(),
      profileName,
      domain,
      savedAt: new Date().toISOString(),
      cookies,
      localStorage: localStorageEntries,
      sessionStorage: sessionStorageEntries,
      activeTabUrl,
      activeTabOrigin
    };
  }

  function focusFieldForSaveError(error) {
    if (!error || !error.message) {
      return;
    }

    if (error.message === PROFILE_NAME_REQUIRED_MESSAGE) {
      profileNameInput.focus();
    }
  }

  saveSessionButton.addEventListener("click", async () => {
    if (busyState) {
      return;
    }

    setBusyState({ scope: "save", action: "save" });
    showStatus("Saving current session...", "info");

    try {
      const profileName = validateProfileName(profileNameInput.value);
      const activeTab = await getCurrentActiveTab();
      const activeTabContext = getActiveTabUrlContext(activeTab);
      const normalizedDomain = normalizeCookieDomain(activeTabContext.hostname);

      setCurrentDomainState(normalizedDomain, "");

      const { cookies } = await readCookiesForProfileScope(
        normalizedDomain,
        activeTabContext.hostname
      );
      const localStorageEntries = await readLocalStorageFromActiveTab();
      const sessionStorageEntries = await readSessionStorageFromActiveTab();
      const profiles = await readProfilesFromStorage();
      const nextProfile = createProfile({
        profileName,
        domain: normalizedDomain,
        cookies,
        localStorageEntries,
        sessionStorageEntries,
        activeTabUrl: activeTabContext.url,
        activeTabOrigin: activeTabContext.origin
      });

      profiles.unshift(nextProfile);
      await writeProfilesToStorage(profiles);
      renderProfiles(profiles);
      showStatus("Session saved successfully", "success");

      profileNameInput.value = "";
      profileNameInput.focus();
    } catch (error) {
      console.error("Failed to save session", error);
      focusFieldForSaveError(error);
      showStatus(error instanceof Error ? error.message : "Failed to save session", "error");
    } finally {
      setBusyState(null);
    }
  });

  initializePopup();
});
