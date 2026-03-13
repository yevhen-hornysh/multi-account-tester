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
      showStatus(failureMessage, "error");
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

    detailsView.append(backButton, title, subtitle, grid);
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
