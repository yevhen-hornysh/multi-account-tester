document.addEventListener("DOMContentLoaded", () => {
  const profileNameInput = document.getElementById("profileName");
  const domainInput = document.getElementById("domain");
  const useCurrentSiteButton = document.getElementById("useCurrentSiteButton");
  const saveSessionButton = document.getElementById("saveSessionButton");
  const profilesList = document.getElementById("profilesList");
  const statusMessage = document.getElementById("statusMessage");

  const STORAGE_KEY = "profiles";
  const PROFILE_NAME_REQUIRED_MESSAGE = "Profile name is required.";
  const DOMAIN_REQUIRED_MESSAGE = "Domain is required.";
  const INVALID_DOMAIN_MESSAGE = "Enter a valid domain.";

  let statusTimeoutId;
  let currentProfiles = [];
  let busyState = null;

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

    saveSessionButton.disabled = isBusy;
    useCurrentSiteButton.disabled = isBusy;
    saveSessionButton.textContent =
      busyState && busyState.scope === "save" ? "Saving..." : "Save current session";
    profileNameInput.disabled = isBusy;
    domainInput.disabled = isBusy;
    renderProfiles(currentProfiles);
  }

  function setBusyState(nextBusyState) {
    busyState = nextBusyState;
    applyBusyState();
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
      throw new Error(DOMAIN_REQUIRED_MESSAGE);
    }

    const valueWithoutProtocol = trimmedValue.replace(/^[a-z]+:\/\//i, "");
    const hostWithOptionalPath = valueWithoutProtocol.split("/")[0];
    const normalizedHost = hostWithOptionalPath.replace(/^\.+/, "").replace(/^www\./, "");

    if (!normalizedHost) {
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

      return {
        url: activeTab.url,
        origin: parsedUrl.origin,
        hostname: parsedUrl.hostname.toLowerCase()
      };
    } catch (error) {
      throw new Error("The active tab does not have a readable URL.");
    }
  }

  async function getCurrentSiteHostname() {
    const activeTab = await getCurrentActiveTab();
    const activeTabContext = getActiveTabUrlContext(activeTab);
    return normalizeCookieDomain(activeTabContext.hostname);
  }

  async function fillDomainFromCurrentSite({ showFeedback = false } = {}) {
    const currentHostname = await getCurrentSiteHostname();
    domainInput.value = currentHostname;

    if (showFeedback) {
      showStatus(`Using ${currentHostname}`, "success");
    }

    return currentHostname;
  }

  function domainsMatch(savedProfileDomain, activeTabHostname) {
    const normalizedSavedDomain = normalizeCookieDomain(savedProfileDomain);
    const normalizedActiveHostname = normalizeCookieDomain(activeTabHostname);

    return (
      normalizedSavedDomain === normalizedActiveHostname ||
      normalizedActiveHostname.endsWith(`.${normalizedSavedDomain}`) ||
      normalizedSavedDomain.endsWith(`.${normalizedActiveHostname}`)
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

  async function clearCookiesForProfileDomain(profileDomain) {
    const { normalizedDomain, cookies } = await readCookiesForDomain(profileDomain);
    const removalResults = await Promise.all(
      cookies.map((cookie) => removeCookie(cookie, normalizedDomain))
    );

    return {
      attempted: cookies.length,
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

  async function restoreProfileCookies(profile) {
    const normalizedDomain = normalizeCookieDomain(profile.domain);
    const savedCookies = Array.isArray(profile.cookies) ? profile.cookies : [];

    await clearCookiesForProfileDomain(normalizedDomain);

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

  async function readLocalStorageFromActiveTab() {
    const activeTab = await getCurrentActiveTab();
    const result = await executeScriptInTab(activeTab.id, collectLocalStorageEntries);
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

    const cookieSummary = await restoreProfileCookies(profile);

    if (cookieSummary.failed > 0) {
      console.error("Some cookies failed to restore", cookieSummary.failures);
      throw new Error("Cookie restore incomplete.");
    }

    await restoreProfileLocalStorage(profile, validation.activeTab);
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

  function createActionButton({ label, busyLabel, variantClass, isBusy, onClick }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${variantClass}`;
    button.disabled = Boolean(busyState);
    button.textContent = isBusy ? busyLabel : label;
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

  function renderEmptyProfilesState() {
    const emptyState = document.createElement("div");
    emptyState.className = "profiles-list__empty";

    const emptyTitle = document.createElement("p");
    emptyTitle.className = "profiles-list__empty-title";
    emptyTitle.textContent = "No profiles saved yet";

    const emptyHint = document.createElement("p");
    emptyHint.className = "profiles-list__empty-hint";
    emptyHint.textContent = "Save the current tab session to create a reusable demo profile.";

    emptyState.append(emptyTitle, emptyHint);
    profilesList.appendChild(emptyState);
  }

  function renderProfiles(profiles) {
    currentProfiles = Array.isArray(profiles) ? profiles : [];
    profilesList.textContent = "";

    if (!currentProfiles.length) {
      renderEmptyProfilesState();
      return;
    }

    const fragment = document.createDocumentFragment();

    currentProfiles.forEach((profile) => {
      const profileCard = document.createElement("article");
      profileCard.className = "profile-card";

      const profileHeader = document.createElement("div");
      profileHeader.className = "profile-card__header";

      const profileName = document.createElement("h3");
      profileName.className = "profile-card__title";
      profileName.textContent = profile.profileName;

      const profileDomain = document.createElement("p");
      profileDomain.className = "profile-card__domain";
      profileDomain.textContent = profile.domain;

      profileHeader.append(profileName, profileDomain);

      const profileMeta = document.createElement("p");
      profileMeta.className = "profile-card__meta";
      profileMeta.textContent =
        `Saved ${formatSavedAt(profile.savedAt)} • ` +
        `${getProfileCookieCount(profile)} cookies • ` +
        `${getProfileLocalStorageCount(profile)} localStorage entries`;

      const actions = document.createElement("div");
      actions.className = "profile-card__actions";

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
        variantClass: "button--ghost",
        isBusy: isProfileActionBusy("delete", profile.id),
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

      actions.append(activateButton, deleteButton);
      profileCard.append(profileHeader, profileMeta, actions);
      fragment.appendChild(profileCard);
    });

    profilesList.appendChild(fragment);
  }

  async function initializePopup() {
    try {
      const profiles = await readProfilesFromStorage();
      renderProfiles(profiles);
    } catch (error) {
      console.error("Failed to load profiles", error);
      renderProfiles([]);
      showStatus("Failed to load saved profiles.", "error");
    }

    try {
      await fillDomainFromCurrentSite();
    } catch (error) {
      console.debug("Could not auto-fill domain from active tab", error);
    }
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
      return;
    }

    if (
      error.message === DOMAIN_REQUIRED_MESSAGE ||
      error.message === INVALID_DOMAIN_MESSAGE
    ) {
      domainInput.focus();
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
      const normalizedDomain = normalizeCookieDomain(domainInput.value);
      const activeTab = await getCurrentActiveTab();
      const activeTabContext = getActiveTabUrlContext(activeTab);
      const { cookies } = await readCookiesForDomain(normalizedDomain);
      const localStorageEntries = await readLocalStorageFromActiveTab();
      const profiles = await readProfilesFromStorage();
      const nextProfile = createProfile({
        profileName,
        domain: normalizedDomain,
        cookies,
        localStorageEntries,
        activeTabUrl: activeTabContext.url,
        activeTabOrigin: activeTabContext.origin
      });

      profiles.unshift(nextProfile);
      await writeProfilesToStorage(profiles);
      renderProfiles(profiles);
      showStatus("Session saved successfully", "success");

      profileNameInput.value = "";

      try {
        await fillDomainFromCurrentSite();
      } catch (error) {
        domainInput.value = "";
      }

      profileNameInput.focus();
    } catch (error) {
      console.error("Failed to save session", error);
      focusFieldForSaveError(error);
      showStatus("Failed to save session", "error");
    } finally {
      setBusyState(null);
    }
  });

  useCurrentSiteButton.addEventListener("click", async () => {
    if (busyState) {
      return;
    }

    try {
      await fillDomainFromCurrentSite({ showFeedback: true });
    } catch (error) {
      console.error("Failed to use current site", error);
      showStatus("Could not read the current site domain.", "error");
    }
  });

  initializePopup();
});
