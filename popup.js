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
  let inspectorSectionStates = new Map();
  let inspectorSearchStates = new Map();
  let pendingSearchFocusKey = "";
  let pendingProfilesListScrollTop = null;
  let pendingDocumentScrollTop = null;
  let editingLocalStorageEntry = null;
  let editingCookieEntry = null;

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
    inspectorSectionStates = new Map();
    inspectorSearchStates = new Map();
    pendingSearchFocusKey = "";
    editingLocalStorageEntry = null;
    editingCookieEntry = null;
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

  async function loadProfiles() {
    const profiles = await readProfilesFromStorage();
    allProfiles = profiles;
    return profiles;
  }

  function getProfileById(profileId, profiles = allProfiles) {
    const profileList = Array.isArray(profiles) ? profiles : [];
    return profileList.find((profile) => profile.id === profileId) || null;
  }

  async function updateProfile(profileId, updater) {
    const profiles = await loadProfiles();
    const profileIndex = profiles.findIndex((profile) => profile.id === profileId);

    if (profileIndex === -1) {
      throw new Error("Profile not found.");
    }

    const currentProfile = profiles[profileIndex];
    const nextProfile = await updater(currentProfile);
    const nextProfiles = [...profiles];
    nextProfiles[profileIndex] = nextProfile;

    await writeProfilesToStorage(nextProfiles);
    allProfiles = nextProfiles;
    return nextProfiles;
  }

  async function updateCookieInProfile(profileId, cookieIndex, updates) {
    return updateProfile(profileId, (profile) => {
      const cookies = getProfileCookies(profile);
      const cookieToUpdate = cookies[cookieIndex];

      if (!cookieToUpdate) {
        throw new Error("Cookie not found.");
      }

      return {
        ...profile,
        cookies: cookies.map((cookie, index) => {
          if (index !== cookieIndex) {
            return cookie;
          }

          return {
            ...cookie,
            ...updates
          };
        })
      };
    });
  }

  async function updateLocalStorageEntry(profileId, { originalKey, nextKey, nextValue }) {
    return updateProfile(profileId, (profile) => {
      const currentEntries = getProfileLocalStorageEntries(profile);
      const hasDuplicateKey = currentEntries.some(([existingKey]) => {
        return existingKey === nextKey && existingKey !== originalKey;
      });

      if (hasDuplicateKey) {
        throw new Error("A localStorage entry with this key already exists.");
      }

      const existingEntry = currentEntries.find(([existingKey]) => existingKey === originalKey);

      if (!existingEntry) {
        throw new Error("LocalStorage entry not found.");
      }

      const localStorage = {};

      currentEntries.forEach(([existingKey, existingValue]) => {
        if (existingKey === originalKey) {
          localStorage[nextKey] = nextValue;
          return;
        }

        localStorage[existingKey] = existingValue;
      });

      return {
        ...profile,
        localStorage
      };
    });
  }

  function buildDomainMismatchMessage(profileDomain, activeTabHostname) {
    return `Domain mismatch: saved for ${profileDomain}, active tab is ${activeTabHostname}.`;
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

  async function captureCurrentSessionSnapshot({ expectedDomain = "" } = {}) {
    const activeTab = await getCurrentActiveTab();
    const activeTabContext = getActiveTabUrlContext(activeTab);
    const normalizedDomain = normalizeCookieDomain(activeTabContext.hostname);
    const cookieScopeDomain = expectedDomain || normalizedDomain;

    if (expectedDomain && !domainsMatch(expectedDomain, normalizedDomain)) {
      throw new Error(buildDomainMismatchMessage(expectedDomain, normalizedDomain));
    }

    const { cookies } = await readCookiesForProfileScope(
      cookieScopeDomain,
      activeTabContext.hostname
    );
    const localStorageEntries = await readLocalStorageFromActiveTab();
    const sessionStorageEntries = await readSessionStorageFromActiveTab();

    return {
      activeTabContext,
      normalizedDomain,
      cookies,
      localStorageEntries,
      sessionStorageEntries
    };
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
        message: buildDomainMismatchMessage(profile.domain, activeTabContext.hostname),
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
      console.warn("Some cookies failed to restore", cookieSummary.failures);
    }

    await restoreProfileLocalStorage(profile, validation.activeTab);
    await restoreProfileSessionStorage(profile, validation.activeTab);
    await reloadTab(validation.activeTab.id);

    return cookieSummary;
  }

  async function deleteProfile(profileId) {
    const profiles = await loadProfiles();
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId);

    await writeProfilesToStorage(nextProfiles);
    allProfiles = nextProfiles;
    return nextProfiles;
  }

  async function refreshProfile(profileId) {
    const profile = getProfileById(profileId);

    if (!profile) {
      throw new Error("Profile not found.");
    }

    const snapshot = await captureCurrentSessionSnapshot({
      expectedDomain: profile.domain
    });

    setCurrentDomainState(snapshot.normalizedDomain, "");

    const nextProfiles = await updateProfile(profileId, (currentProfile) => ({
      ...currentProfile,
      domain: snapshot.normalizedDomain,
      savedAt: new Date().toISOString(),
      cookies: snapshot.cookies,
      localStorage: snapshot.localStorageEntries,
      sessionStorage: snapshot.sessionStorageEntries,
      activeTabUrl: snapshot.activeTabContext.url,
      activeTabOrigin: snapshot.activeTabContext.origin
    }));

    renderProfiles(nextProfiles);

    return {
      cookies: snapshot.cookies.length,
      localStorage: Object.keys(snapshot.localStorageEntries).length
    };
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

  function formatCookieFailureSummary(failures) {
    const failureList = Array.isArray(failures) ? failures : [];

    if (!failureList.length) {
      return "";
    }

    const uniqueNames = Array.from(
      new Set(
        failureList.map(({ cookieName }) => {
          return cookieName && String(cookieName).trim() ? String(cookieName).trim() : "(unnamed)";
        })
      )
    );
    const preview = uniqueNames.slice(0, 3).join(", ");

    if (uniqueNames.length <= 3) {
      return preview;
    }

    return `${preview} and ${uniqueNames.length - 3} more`;
  }

  function getProfileCookieCount(profile) {
    return Array.isArray(profile.cookies) ? profile.cookies.length : 0;
  }

  function getProfileCookies(profile) {
    return Array.isArray(profile.cookies) ? profile.cookies : [];
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
    editingCookieEntry = null;
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
    const nextProfiles = await updateLocalStorageEntry(profileId, {
      originalKey: editingLocalStorageEntry.originalKey,
      nextKey: editingLocalStorageEntry.draftKey,
      nextValue: editingLocalStorageEntry.draftValue
    });
    editingLocalStorageEntry = null;
    renderProfiles(nextProfiles);
  }

  function getNormalizedCookieSameSiteValue(sameSite) {
    if (
      sameSite === "lax" ||
      sameSite === "strict" ||
      sameSite === "no_restriction" ||
      sameSite === "unspecified"
    ) {
      return sameSite;
    }

    return "unspecified";
  }

  function isEditingCookieEntry(profileId, cookieIndex) {
    return Boolean(
      editingCookieEntry &&
        editingCookieEntry.profileId === profileId &&
        editingCookieEntry.cookieIndex === cookieIndex
    );
  }

  function startEditingCookieEntry(profileId, cookieIndex, cookie) {
    editingLocalStorageEntry = null;
    editingCookieEntry = {
      profileId,
      cookieIndex,
      draftName: typeof cookie.name === "string" ? cookie.name : "",
      draftValue: typeof cookie.value === "string" ? cookie.value : "",
      draftPath: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
      draftSameSite: getNormalizedCookieSameSiteValue(cookie.sameSite)
    };
    renderProfiles(allProfiles);
  }

  function cancelEditingCookieEntry() {
    editingCookieEntry = null;
    renderProfiles(allProfiles);
  }

  async function saveCookieEntry(profileId) {
    if (!editingCookieEntry || editingCookieEntry.profileId !== profileId) {
      return;
    }

    const nextPath = editingCookieEntry.draftPath.trim() || "/";
    const nextSameSite = getNormalizedCookieSameSiteValue(editingCookieEntry.draftSameSite);
    const nextProfiles = await updateCookieInProfile(profileId, editingCookieEntry.cookieIndex, {
      name: editingCookieEntry.draftName,
      value: editingCookieEntry.draftValue,
      path: nextPath,
      sameSite: nextSameSite
    });
    editingCookieEntry = null;
    renderProfiles(nextProfiles);
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
    } else if (iconName === "refresh") {
      path.setAttribute(
        "d",
        "M20 11a8 8 0 1 0 2 5.3 M20 11v-6 M20 11h-6"
      );
    } else if (iconName === "edit") {
      path.setAttribute(
        "d",
        "M12 20h9 M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
      );
    } else if (iconName === "search") {
      path.setAttribute(
        "d",
        "m21 21-4.35-4.35 M10.75 18a7.25 7.25 0 1 1 0-14.5 7.25 7.25 0 0 1 0 14.5Z"
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
    formatSuccessMessage,
    successType = "success",
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
      const result = await run();
      const nextSuccessMessage =
        typeof formatSuccessMessage === "function"
          ? formatSuccessMessage(result)
          : successMessage;
      showStatus(nextSuccessMessage, successType);
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

  function getInspectorSectionKey(profileId, sectionName) {
    return `${profileId}:section:${sectionName}`;
  }

  function getInspectorSearchKey(profileId, sectionName) {
    return `${profileId}:search:${sectionName}`;
  }

  function isInspectorSectionCollapsed(profileId, sectionName, defaultCollapsed = false) {
    const sectionKey = getInspectorSectionKey(profileId, sectionName);

    if (!inspectorSectionStates.has(sectionKey)) {
      return defaultCollapsed;
    }

    return inspectorSectionStates.get(sectionKey) === true;
  }

  function toggleInspectorSection(profileId, sectionName, defaultCollapsed = false) {
    const sectionKey = getInspectorSectionKey(profileId, sectionName);
    const currentState = isInspectorSectionCollapsed(profileId, sectionName, defaultCollapsed);
    inspectorSectionStates.set(sectionKey, !currentState);

    renderProfiles(allProfiles);
  }

  function getInspectorSearchState(profileId, sectionName) {
    const sectionKey = getInspectorSearchKey(profileId, sectionName);

    if (!inspectorSearchStates.has(sectionKey)) {
      inspectorSearchStates.set(sectionKey, {
        isVisible: false,
        query: ""
      });
    }

    return inspectorSearchStates.get(sectionKey);
  }

  function toggleInspectorSearch(profileId, sectionName) {
    const sectionKey = getInspectorSearchKey(profileId, sectionName);
    const currentState = getInspectorSearchState(profileId, sectionName);
    const nextState = {
      ...currentState,
      isVisible: !currentState.isVisible
    };

    inspectorSearchStates.set(sectionKey, nextState);
    pendingSearchFocusKey = nextState.isVisible ? sectionKey : "";
    renderProfiles(allProfiles);
  }

  function updateInspectorSearchQuery(profileId, sectionName, query) {
    const sectionKey = getInspectorSearchKey(profileId, sectionName);
    const currentState = getInspectorSearchState(profileId, sectionName);

    inspectorSearchStates.set(sectionKey, {
      ...currentState,
      query
    });

    if (
      sectionName === "cookies" &&
      currentView === "details" &&
      selectedProfileId === profileId
    ) {
      updateRenderedCookiesSection(profileId);
      return;
    }

    pendingProfilesListScrollTop = profilesList.scrollTop;
    pendingDocumentScrollTop = document.scrollingElement
      ? document.scrollingElement.scrollTop
      : null;
    pendingSearchFocusKey = sectionKey;
    renderProfiles(allProfiles);
  }

  function createSectionEmptyState({ title, description }) {
    const emptyState = document.createElement("div");
    emptyState.className = "inspector-empty-state";

    const emptyStateTitle = document.createElement("p");
    emptyStateTitle.className = "inspector-empty-state__title";
    emptyStateTitle.textContent = title;

    const emptyStateDescription = document.createElement("p");
    emptyStateDescription.className = "inspector-empty-state__description";
    emptyStateDescription.textContent = description;

    emptyState.append(emptyStateTitle, emptyStateDescription);
    return emptyState;
  }

  function createInspectorSection({
    profileId,
    sectionName,
    title,
    description = "",
    countText = "",
    isCollapsible = false,
    defaultCollapsed = false,
    showSearch = false,
    content
  }) {
    const section = document.createElement("section");
    section.className = "inspector-section";
    section.dataset.profileId = profileId;
    section.dataset.sectionName = sectionName;

    const header = document.createElement("div");
    header.className = "inspector-section__header";

    const titleGroup = document.createElement("div");
    titleGroup.className = "inspector-section__title-group";

    const heading = document.createElement("h4");
    heading.className = "inspector-section__title";
    heading.textContent = title;

    titleGroup.appendChild(heading);

    if (description) {
      const subtitle = document.createElement("p");
      subtitle.className = "inspector-section__description";
      subtitle.textContent = description;
      titleGroup.appendChild(subtitle);
    }

    header.appendChild(titleGroup);

    const controls = document.createElement("div");
    controls.className = "inspector-section__controls";

    if (showSearch) {
      const searchState = getInspectorSearchState(profileId, sectionName);
      const searchControl = document.createElement("div");
      searchControl.className = `inspector-section__search${
        searchState.isVisible ? " is-visible" : ""
      }`;

      const searchButton = createActionButton({
        label: searchState.isVisible ? "Hide search" : "Show search",
        busyLabel: searchState.isVisible ? "Hide search" : "Show search",
        variantClass: "button--icon button--ghost button--icon-small inspector-section__search-button",
        isBusy: false,
        iconName: "search",
        title: searchState.isVisible ? "Hide search" : "Show search",
        onClick: () => toggleInspectorSearch(profileId, sectionName)
      });
      searchButton.disabled = false;
      searchControl.appendChild(searchButton);

      if (searchState.isVisible) {
        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.className = "inspector-section__search-input";
        searchInput.placeholder = "Search...";
        searchInput.value = searchState.query;
        searchInput.autocomplete = "off";
        searchInput.setAttribute("aria-label", `${title} search`);
        searchInput.addEventListener("input", (event) => {
          updateInspectorSearchQuery(profileId, sectionName, event.target.value);
        });
        searchControl.appendChild(searchInput);

        if (pendingSearchFocusKey === getInspectorSearchKey(profileId, sectionName)) {
          window.setTimeout(() => {
            try {
              searchInput.focus({ preventScroll: true });
            } catch (error) {
              searchInput.focus();
            }
            searchInput.setSelectionRange(
              searchInput.value.length,
              searchInput.value.length
            );
          }, 0);
          pendingSearchFocusKey = "";
        }
      }

      controls.appendChild(searchControl);
    }

    if (countText) {
      const count = document.createElement("span");
      count.className = "profile-details__section-count";
      count.dataset.role = "section-count";
      count.textContent = countText;
      controls.appendChild(count);
    }

    const isCollapsed = isCollapsible
      ? isInspectorSectionCollapsed(profileId, sectionName, defaultCollapsed)
      : false;

    if (isCollapsible) {
      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "inspector-section__toggle";
      toggleButton.dataset.role = "section-toggle";
      toggleButton.textContent = isCollapsed ? "Expand" : "Collapse";
      toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
      toggleButton.addEventListener("click", () =>
        toggleInspectorSection(profileId, sectionName, defaultCollapsed)
      );
      controls.appendChild(toggleButton);
    }

    if (controls.childNodes.length) {
      header.appendChild(controls);
    }

    const body = document.createElement("div");
    body.className = "inspector-section__body";
    body.dataset.role = "section-body";

    if (isCollapsed) {
      body.hidden = true;
    }

    if (content) {
      body.appendChild(content);
    }

    section.append(header, body);
    return section;
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

  function normalizeInspectorSearchQuery(query) {
    return typeof query === "string" ? query.trim().toLowerCase() : "";
  }

  function getCookieSearchFields(cookie, profileDomain = "") {
    return {
      name: cookie && typeof cookie.name === "string" ? cookie.name : "",
      value: cookie && typeof cookie.value === "string" ? cookie.value : "",
      domain: cookie && typeof cookie.domain === "string" ? cookie.domain : profileDomain,
      path: cookie && typeof cookie.path === "string" ? cookie.path : "/",
      sameSite: formatCookieSameSite(cookie ? cookie.sameSite : "")
    };
  }

  function getCookieMatchScore(cookie, normalizedQuery, profileDomain = "") {
    if (!normalizedQuery) {
      return null;
    }

    const searchFields = Object.values(getCookieSearchFields(cookie, profileDomain));
    let bestScore = null;

    searchFields.forEach((fieldValue, fieldIndex) => {
      const normalizedFieldValue =
        typeof fieldValue === "string" ? fieldValue.toLowerCase() : String(fieldValue).toLowerCase();
      const matchIndex = normalizedFieldValue.indexOf(normalizedQuery);

      if (matchIndex === -1) {
        return;
      }

      let priority = 3;

      if (normalizedFieldValue === normalizedQuery) {
        priority = 1;
      } else if (matchIndex === 0) {
        priority = 2;
      }

      const nextScore = {
        priority,
        matchIndex,
        fieldIndex
      };

      if (
        !bestScore ||
        nextScore.priority < bestScore.priority ||
        (nextScore.priority === bestScore.priority && nextScore.matchIndex < bestScore.matchIndex) ||
        (nextScore.priority === bestScore.priority &&
          nextScore.matchIndex === bestScore.matchIndex &&
          nextScore.fieldIndex < bestScore.fieldIndex)
      ) {
        bestScore = nextScore;
      }
    });

    return bestScore;
  }

  function createHighlightedTextFragment(value, query) {
    const fragment = document.createDocumentFragment();
    const textValue =
      typeof value === "string" ? value : value === null || typeof value === "undefined" ? "" : String(value);
    const normalizedQuery = normalizeInspectorSearchQuery(query);

    if (!normalizedQuery || !textValue) {
      fragment.appendChild(document.createTextNode(textValue));
      return fragment;
    }

    const normalizedValue = textValue.toLowerCase();
    let startIndex = 0;
    let matchIndex = normalizedValue.indexOf(normalizedQuery, startIndex);

    while (matchIndex !== -1) {
      if (matchIndex > startIndex) {
        fragment.appendChild(document.createTextNode(textValue.slice(startIndex, matchIndex)));
      }

      const highlight = document.createElement("mark");
      highlight.className = "cookie-item__highlight";
      highlight.textContent = textValue.slice(matchIndex, matchIndex + normalizedQuery.length);
      fragment.appendChild(highlight);

      startIndex = matchIndex + normalizedQuery.length;
      matchIndex = normalizedValue.indexOf(normalizedQuery, startIndex);
    }

    if (startIndex < textValue.length) {
      fragment.appendChild(document.createTextNode(textValue.slice(startIndex)));
    }

    return fragment;
  }

  function filterCookiesByQuery(cookies, query, profileDomain = "") {
    const normalizedQuery = normalizeInspectorSearchQuery(query);

    if (!normalizedQuery) {
      return cookies.map((cookie, cookieIndex) => ({ cookie, cookieIndex }));
    }

    return cookies
      .map((cookie, cookieIndex) => ({
        cookie,
        cookieIndex,
        matchScore: getCookieMatchScore(cookie, normalizedQuery, profileDomain)
      }))
      .filter(({ matchScore }) => Boolean(matchScore))
      .sort((firstResult, secondResult) => {
        if (firstResult.matchScore.priority !== secondResult.matchScore.priority) {
          return firstResult.matchScore.priority - secondResult.matchScore.priority;
        }

        if (firstResult.matchScore.matchIndex !== secondResult.matchScore.matchIndex) {
          return firstResult.matchScore.matchIndex - secondResult.matchScore.matchIndex;
        }

        if (firstResult.matchScore.fieldIndex !== secondResult.matchScore.fieldIndex) {
          return firstResult.matchScore.fieldIndex - secondResult.matchScore.fieldIndex;
        }

        return firstResult.cookieIndex - secondResult.cookieIndex;
      });
  }

  function buildCookiesSectionContent(profile) {
    const cookies = getProfileCookies(profile);
    const searchQuery = getInspectorSearchState(profile.id, "cookies").query;
    const filteredCookies = filterCookiesByQuery(cookies, searchQuery, profile.domain || "");

    if (!cookies.length) {
      return {
        countText: "0 saved",
        isCollapsible: false,
        defaultCollapsed: false,
        content: createSectionEmptyState({
          title: "No cookies saved",
          description: "Save a session after signing in to capture cookies for this site."
        })
      };
    }

    if (!filteredCookies.length) {
      return {
        countText: `0 of ${cookies.length} saved`,
        isCollapsible: false,
        defaultCollapsed: false,
        content: createSectionEmptyState({
          title: "No cookies match your search",
          description: "Try a different value or clear the search field."
        })
      };
    }

    const list = document.createElement("div");
    list.className = "inspector-list inspector-list--scrollable";

    filteredCookies.forEach(({ cookie, cookieIndex }) => {
      const item = document.createElement("article");
      item.className = `cookie-item${
        isEditingCookieEntry(profile.id, cookieIndex) ? " cookie-item--editing" : ""
      }`;

      const itemHeader = document.createElement("div");
      itemHeader.className = "cookie-item__header";

      const itemTitle = document.createElement("h5");
      itemTitle.className = "cookie-item__title";
      itemTitle.appendChild(createHighlightedTextFragment(cookie.name || "Unnamed cookie", searchQuery));

      const editButton = createActionButton({
        label: "Edit cookie",
        busyLabel: "Edit cookie",
        variantClass: "button--icon button--ghost button--icon-small",
        isBusy: false,
        iconName: "edit",
        title: "Edit cookie",
        onClick: () => startEditingCookieEntry(profile.id, cookieIndex, cookie)
      });
      editButton.disabled = Boolean(
        busyState ||
          editingLocalStorageEntry ||
          (editingCookieEntry && !isEditingCookieEntry(profile.id, cookieIndex))
      );

      itemHeader.append(itemTitle, editButton);

      const itemMeta = document.createElement("div");
      itemMeta.className = "cookie-item__meta";

      const secureBadge = document.createElement("span");
      secureBadge.className = "cookie-item__badge";
      secureBadge.textContent = cookie.secure ? "Secure" : "Not secure";

      const httpOnlyBadge = document.createElement("span");
      httpOnlyBadge.className = "cookie-item__badge";
      httpOnlyBadge.textContent = cookie.httpOnly ? "HttpOnly" : "Readable";

      itemMeta.append(secureBadge, httpOnlyBadge);
      item.append(itemHeader, itemMeta);

      if (isEditingCookieEntry(profile.id, cookieIndex)) {
        item.appendChild(createCookieEditor(profile.id));
      } else {
        item.append(
          createCookieValueRow({ profileId: profile.id, cookie, cookieIndex, searchQuery }),
          createCookieDetailRow("Domain", cookie.domain || profile.domain || "Unknown", "", searchQuery),
          createCookieDetailRow("Path", cookie.path || "/", "", searchQuery),
          createCookieDetailRow("Secure", cookie.secure ? "Yes" : "No"),
          createCookieDetailRow("HttpOnly", cookie.httpOnly ? "Yes" : "No"),
          createCookieDetailRow("SameSite", formatCookieSameSite(cookie.sameSite), "", searchQuery),
          createCookieDetailRow("Expires", formatCookieExpiration(cookie.expirationDate))
        );
      }

      list.appendChild(item);
    });

    return {
      countText: searchQuery.trim()
        ? `${filteredCookies.length} of ${cookies.length} saved`
        : `${cookies.length} saved`,
      isCollapsible: filteredCookies.length > 4,
      defaultCollapsed: filteredCookies.length > 8,
      content: list
    };
  }

  function updateRenderedCookiesSection(profileId) {
    const profile = getProfileById(profileId);

    if (!profile) {
      return;
    }

    const section = profilesList.querySelector(
      `.inspector-section[data-profile-id="${profileId}"][data-section-name="cookies"]`
    );

    if (!section) {
      return;
    }

    const body = section.querySelector('[data-role="section-body"]');
    const count = section.querySelector('[data-role="section-count"]');
    const toggleButton = section.querySelector('[data-role="section-toggle"]');
    const { content, countText, isCollapsible, defaultCollapsed } =
      buildCookiesSectionContent(profile);
    const isCollapsed = isCollapsible
      ? isInspectorSectionCollapsed(profileId, "cookies", defaultCollapsed)
      : false;

    if (count) {
      count.textContent = countText;
    }

    if (body) {
      body.textContent = "";
      body.appendChild(content);
      body.hidden = isCollapsed;
    }

    if (toggleButton) {
      if (isCollapsible) {
        toggleButton.hidden = false;
        toggleButton.textContent = isCollapsed ? "Expand" : "Collapse";
        toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
      } else {
        toggleButton.hidden = true;
      }
    }
  }

  function createCookieDetailRow(label, value, extraClassName = "", highlightQuery = "") {
    const row = document.createElement("div");
    row.className = "cookie-item__row";

    const key = document.createElement("span");
    key.className = "cookie-item__key";
    key.textContent = label;

    const content = document.createElement("span");
    content.className = `cookie-item__value ${extraClassName}`.trim();
    content.appendChild(createHighlightedTextFragment(value, highlightQuery));

    row.append(key, content);
    return row;
  }

  function createExpandableValueRow({
    expansionKey,
    label = "Value",
    value,
    emptyValueLabel = "(empty)",
    highlightQuery = ""
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
    content.appendChild(
      createHighlightedTextFragment(normalizedValue || emptyValueLabel, highlightQuery)
    );

    row.append(rowHeader, content);
    return row;
  }

  function createCookieValueRow({ profileId, cookie, cookieIndex, searchQuery = "" }) {
    return createExpandableValueRow({
      expansionKey: `${profileId}:cookie:${cookieIndex}:${cookie.name}`,
      value: cookie.value,
      highlightQuery: searchQuery
    });
  }

  function createCookieEditor(profileId) {
    const editor = document.createElement("div");
    editor.className = "cookie-editor";

    const fields = [
      {
        label: "Name",
        type: "text",
        value: editingCookieEntry ? editingCookieEntry.draftName : "",
        onInput: (event) => {
          if (editingCookieEntry) {
            editingCookieEntry.draftName = event.target.value;
          }
        }
      },
      {
        label: "Value",
        type: "textarea",
        value: editingCookieEntry ? editingCookieEntry.draftValue : "",
        onInput: (event) => {
          if (editingCookieEntry) {
            editingCookieEntry.draftValue = event.target.value;
          }
        }
      },
      {
        label: "Path",
        type: "text",
        value: editingCookieEntry ? editingCookieEntry.draftPath : "/",
        onInput: (event) => {
          if (editingCookieEntry) {
            editingCookieEntry.draftPath = event.target.value;
          }
        }
      }
    ];

    fields.forEach((field) => {
      const fieldWrapper = document.createElement("label");
      fieldWrapper.className = "cookie-editor__field";

      const fieldLabel = document.createElement("span");
      fieldLabel.className = "cookie-editor__label";
      fieldLabel.textContent = field.label;

      let input;

      if (field.type === "textarea") {
        input = document.createElement("textarea");
        input.className = "cookie-editor__textarea";
        input.rows = 3;
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.className = "cookie-editor__input";
      }

      input.value = field.value;
      input.disabled = Boolean(busyState);
      input.addEventListener("input", field.onInput);
      fieldWrapper.append(fieldLabel, input);
      editor.appendChild(fieldWrapper);
    });

    const sameSiteField = document.createElement("label");
    sameSiteField.className = "cookie-editor__field";

    const sameSiteLabel = document.createElement("span");
    sameSiteLabel.className = "cookie-editor__label";
    sameSiteLabel.textContent = "SameSite";

    const sameSiteSelect = document.createElement("select");
    sameSiteSelect.className = "cookie-editor__select";
    sameSiteSelect.disabled = Boolean(busyState);

    [
      ["unspecified", "Not set"],
      ["lax", "Lax"],
      ["strict", "Strict"],
      ["no_restriction", "None"]
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = editingCookieEntry && editingCookieEntry.draftSameSite === value;
      sameSiteSelect.appendChild(option);
    });

    sameSiteSelect.addEventListener("change", (event) => {
      if (editingCookieEntry) {
        editingCookieEntry.draftSameSite = event.target.value;
      }
    });

    sameSiteField.append(sameSiteLabel, sameSiteSelect);
    editor.appendChild(sameSiteField);

    const readOnlyNote = document.createElement("p");
    readOnlyNote.className = "cookie-editor__note";
    readOnlyNote.textContent = "Domain, Secure, HttpOnly, and Expires stay read-only.";

    const actions = document.createElement("div");
    actions.className = "cookie-editor__actions";

    const saveButton = createActionButton({
      label: "Save",
      busyLabel: "Saving...",
      variantClass: "button--secondary button--compact",
      isBusy: isProfileActionBusy("edit-cookie", profileId),
      onClick: async () => {
        await handleProfileAction({
          profile: { id: profileId, profileName: "cookie" },
          action: "edit-cookie",
          beforeMessage: "Saving cookie changes...",
          successMessage: "Cookie updated in saved profile",
          failureMessage: "Failed to update cookie.",
          run: () => saveCookieEntry(profileId)
        });
      }
    });
    saveButton.disabled = Boolean(busyState);

    const cancelButton = createActionButton({
      label: "Cancel",
      busyLabel: "Cancel",
      variantClass: "button--ghost button--compact",
      isBusy: false,
      onClick: () => cancelEditingCookieEntry()
    });
    cancelButton.disabled = Boolean(busyState);

    actions.append(saveButton, cancelButton);
    editor.append(readOnlyNote, actions);

    window.setTimeout(() => {
      const firstInput = editor.querySelector(".cookie-editor__input");

      if (firstInput instanceof HTMLInputElement) {
        firstInput.focus();
        firstInput.setSelectionRange(firstInput.value.length, firstInput.value.length);
      }
    }, 0);

    return editor;
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
    const { content, countText, isCollapsible, defaultCollapsed } =
      buildCookiesSectionContent(profile);

    return createInspectorSection({
      profileId: profile.id,
      sectionName: "cookies",
      title: "Cookies",
      description: "Saved authentication and preference cookies for this profile.",
      countText,
      isCollapsible,
      defaultCollapsed,
      showSearch: true,
      content
    });
  }

  function renderLocalStorageSection(profile) {
    const entries = getProfileLocalStorageEntries(profile);

    if (!entries.length) {
      return createInspectorSection({
        profileId: profile.id,
        sectionName: "local-storage",
        title: "LocalStorage",
        description: "Saved per-origin values captured from the active tab.",
        countText: "0 saved",
        content: createSectionEmptyState({
          title: "No localStorage saved",
          description: "This profile did not capture any localStorage entries for the current origin."
        }),
        showSearch: true
      });
    }

    const list = document.createElement("div");
    list.className = "inspector-list inspector-list--scrollable";

    entries.forEach(([entryKey, entryValue], entryIndex) => {
      const item = document.createElement("article");
      item.className = `cookie-item${
        isEditingLocalStorageEntry(profile.id, entryKey) ? " cookie-item--editing" : ""
      }`;

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
          editingCookieEntry ||
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

    return createInspectorSection({
      profileId: profile.id,
      sectionName: "local-storage",
      title: "LocalStorage",
      description: "Saved per-origin values captured from the active tab.",
      countText: `${entries.length} saved`,
      isCollapsible: entries.length > 4,
      defaultCollapsed: entries.length > 8,
      showSearch: true,
      content: list
    });
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

    const profileInfoSection = createInspectorSection({
      profileId: profile.id,
      sectionName: "profile-info",
      title: "Profile Info",
      description: "Snapshot metadata and storage counts for this saved session.",
      countText: "Overview",
      content: grid
    });

    detailsView.append(
      backButton,
      title,
      subtitle,
      profileInfoSection,
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

      const refreshButton = createActionButton({
        label: "Update profile",
        busyLabel: "Updating...",
        variantClass: "button--icon button--ghost",
        isBusy: isProfileActionBusy("refresh", profile.id),
        iconName: "refresh",
        title: "Update saved session from current tab",
        onClick: async () => {
          await handleProfileAction({
            profile,
            action: "refresh",
            beforeMessage: `Updating ${profile.profileName}...`,
            successMessage: "Profile updated successfully",
            failureMessage: "Failed to update profile",
            run: () => refreshProfile(profile.id)
          });
        }
      });
      refreshButton.disabled = Boolean(busyState);

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
            formatSuccessMessage: (cookieSummary) => {
              if (!cookieSummary || cookieSummary.failed <= 0) {
                return "Session activated successfully";
              }

              const failedCookies = formatCookieFailureSummary(cookieSummary.failures);
              return failedCookies
                ? `Session activated. Some cookies were skipped: ${failedCookies}.`
                : "Session activated. Some cookies were skipped.";
            },
            successType: "success",
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

      actions.append(viewDetailsButton, refreshButton, activateButton, deleteButton);
      profileCard.append(profileTopRow, profileMetaRow, actions);
      fragment.appendChild(profileCard);
    });

    profilesList.appendChild(fragment);
  }

  function restorePendingProfilesListScrollPosition() {
    if (typeof pendingProfilesListScrollTop === "number") {
      profilesList.scrollTop = pendingProfilesListScrollTop;
      pendingProfilesListScrollTop = null;
    }
  }

  function restorePendingDocumentScrollPosition() {
    const scrollingElement = document.scrollingElement;

    if (scrollingElement && typeof pendingDocumentScrollTop === "number") {
      scrollingElement.scrollTop = pendingDocumentScrollTop;
      pendingDocumentScrollTop = null;
    }
  }

  function renderProfiles(profiles) {
    allProfiles = Array.isArray(profiles) ? profiles : [];
    currentProfiles = filterProfilesByDomain(allProfiles, currentDomain);
    profilesList.textContent = "";

    if (!currentDomain) {
      currentView = "list";
      selectedProfileId = "";
      renderCurrentSiteUnavailableState();
      restorePendingProfilesListScrollPosition();
      restorePendingDocumentScrollPosition();
      return;
    }

    if (currentView === "details") {
      const selectedProfile = getProfileById(selectedProfileId);

      if (!selectedProfile || !isDomainFilterMatch(selectedProfile.domain, currentDomain)) {
        currentView = "list";
        selectedProfileId = "";
        renderProfilesListView();
        restorePendingProfilesListScrollPosition();
        restorePendingDocumentScrollPosition();
        return;
      }

      renderProfileDetailsView(selectedProfile);
      restorePendingProfilesListScrollPosition();
      restorePendingDocumentScrollPosition();
      return;
    }

    renderProfilesListView();
    restorePendingProfilesListScrollPosition();
    restorePendingDocumentScrollPosition();
  }

  async function initializePopup() {
    try {
      await loadProfiles();
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
      const snapshot = await captureCurrentSessionSnapshot();
      const normalizedDomain = snapshot.normalizedDomain;

      setCurrentDomainState(normalizedDomain, "");
      const profiles = await loadProfiles();
      const nextProfile = createProfile({
        profileName,
        domain: normalizedDomain,
        cookies: snapshot.cookies,
        localStorageEntries: snapshot.localStorageEntries,
        sessionStorageEntries: snapshot.sessionStorageEntries,
        activeTabUrl: snapshot.activeTabContext.url,
        activeTabOrigin: snapshot.activeTabContext.origin
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
