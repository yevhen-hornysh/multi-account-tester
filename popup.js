document.addEventListener("DOMContentLoaded", () => {
  const profileNameInput = document.getElementById("profileName");
  const domainInput = document.getElementById("domain");
  const saveSessionButton = document.getElementById("saveSessionButton");
  const profilesList = document.getElementById("profilesList");
  const statusMessage = document.getElementById("statusMessage");
  const STORAGE_KEY = "profiles";

  let statusTimeoutId;

  function showStatus(message, type = "info") {
    window.clearTimeout(statusTimeoutId);
    statusMessage.textContent = message;
    statusMessage.className = `status-message is-visible status-message--${type}`;

    statusTimeoutId = window.setTimeout(() => {
      statusMessage.textContent = "";
      statusMessage.className = "status-message";
    }, 1800);
  }

  function loadProfiles() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        resolve(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
      });
    });
  }

  function saveProfiles(profiles) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: profiles }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        resolve();
      });
    });
  }

  function validateProfileName(input) {
    const trimmedValue = input.trim();

    if (!trimmedValue) {
      throw new Error("Profile name is required.");
    }

    return trimmedValue;
  }

  function normalizeCookieDomain(input) {
    const trimmedValue = input.trim().toLowerCase();

    if (!trimmedValue) {
      throw new Error("Domain is required.");
    }

    const valueWithoutProtocol = trimmedValue.replace(/^[a-z]+:\/\//i, "");
    const hostWithOptionalPath = valueWithoutProtocol.split("/")[0];
    const normalizedHost = hostWithOptionalPath.replace(/^\.+/, "").replace(/^www\./, "");

    if (!normalizedHost) {
      throw new Error("Enter a valid domain.");
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
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
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
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!Array.isArray(tabs) || !tabs.length) {
          reject(new Error("No active tab found."));
          return;
        }

        const [activeTab] = tabs;

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

  function domainsMatch(savedProfileDomain, activeTabHostname) {
    const normalizedSavedDomain = normalizeCookieDomain(savedProfileDomain);
    const normalizedActiveHostname = normalizeCookieDomain(activeTabHostname);

    if (normalizedSavedDomain === normalizedActiveHostname) {
      return true;
    }

    return (
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
      type: "success"
    };
  }

  function buildCookieUrl(cookie, fallbackHostname) {
    const normalizedFallbackHost = normalizeCookieDomain(fallbackHostname);
    const cookieDomain =
      typeof cookie.domain === "string" && cookie.domain.trim()
        ? cookie.domain.replace(/^\.+/, "")
        : normalizedFallbackHost;
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
          if (chrome.runtime.lastError) {
            resolve({
              removed: false,
              error: new Error(chrome.runtime.lastError.message)
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
      const details = {
        url: buildCookieUrl(cookie, fallbackHostname),
        name: cookie.name,
        value: typeof cookie.value === "string" ? cookie.value : "",
        path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly)
      };

      if (typeof cookie.domain === "string" && cookie.domain.trim()) {
        details.domain = cookie.domain;
      }

      if (typeof cookie.sameSite === "string" && cookie.sameSite) {
        details.sameSite = cookie.sameSite;
      }

      if (typeof cookie.expirationDate === "number") {
        details.expirationDate = cookie.expirationDate;
      }

      if (typeof cookie.storeId === "string" && cookie.storeId) {
        details.storeId = cookie.storeId;
      }

      chrome.cookies.set(details, (createdCookie) => {
        if (chrome.runtime.lastError) {
          resolve({
            restored: false,
            error: new Error(chrome.runtime.lastError.message)
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

  async function readLocalStorageFromActiveTab() {
    const activeTab = await getCurrentActiveTab();

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: collectLocalStorageEntries
      });

      const [result] = Array.isArray(results) ? results : [];

      if (!result || !result.result || typeof result.result !== "object") {
        return {};
      }

      return result.result;
    } catch (error) {
      throw new Error(error && error.message ? error.message : "Failed to inject localStorage reader.");
    }
  }

  async function deleteProfile(profileId) {
    const profiles = await loadProfiles();
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId);

    await saveProfiles(nextProfiles);
    return nextProfiles;
  }

  function formatSavedAt(savedAt) {
    return new Date(savedAt).toLocaleString();
  }

  function renderProfiles(profiles) {
    profilesList.textContent = "";

    if (!profiles.length) {
      const emptyState = document.createElement("p");
      emptyState.className = "profiles-list__empty";
      emptyState.textContent = "No saved profiles yet.";
      profilesList.appendChild(emptyState);
      return;
    }

    const fragment = document.createDocumentFragment();

    profiles.forEach((profile) => {
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
      profileMeta.textContent = `Saved ${formatSavedAt(profile.savedAt)}`;

      const actions = document.createElement("div");
      actions.className = "profile-card__actions";

      const activateButton = document.createElement("button");
      activateButton.type = "button";
      activateButton.className = "button button--secondary";
      activateButton.textContent = "Activate";
      activateButton.addEventListener("click", async () => {
        try {
          const validation = await validateActivation(profile);

          if (!validation.canActivate) {
            showStatus(validation.message, validation.type);
            return;
          }

          const restoreSummary = await restoreProfileCookies(profile);

          if (restoreSummary.failed > 0) {
            console.error("Some cookies failed to restore", restoreSummary.failures);
            showStatus(
              `Restored ${restoreSummary.restored} of ${restoreSummary.total} cookies`,
              "error"
            );
            return;
          }

          showStatus(
            `Restored ${restoreSummary.restored} of ${restoreSummary.total} cookies`,
            "success"
          );
        } catch (error) {
          console.error("Activation failed", error);

          if (error && error.message === "No active tab found.") {
            showStatus("No active tab found.", "error");
            return;
          }

          if (error && error.message === "The active tab does not have a readable URL.") {
            showStatus("The active tab does not have a readable URL.", "error");
            return;
          }

          if (error && error.message) {
            showStatus(error.message, "error");
            return;
          }

          showStatus("Cookie restore failed.", "error");
        }
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "button button--ghost";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", async () => {
        try {
          const profiles = await deleteProfile(profile.id);
          renderProfiles(profiles);
          showStatus("Profile deleted", "success");
        } catch (error) {
          console.error("Failed to delete profile", error);
          showStatus("Failed to delete profile.", "error");
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
      const profiles = await loadProfiles();
      renderProfiles(profiles);
    } catch (error) {
      console.error("Failed to load profiles", error);
      renderProfiles([]);
      showStatus("Failed to load saved profiles.", "error");
    }
  }

  /**
   * Saved profile shape stored in chrome.storage.local under the "profiles" key.
   * {
   *   id: string,
   *   profileName: string,
   *   domain: string,
   *   savedAt: string,
   *   cookies: chrome.cookies.Cookie[],
   *   localStorage: Record<string, string | null>,
   *   activeTabUrl: string,
   *   activeTabOrigin: string
   * }
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

  saveSessionButton.addEventListener("click", async () => {
    try {
      const profileName = validateProfileName(profileNameInput.value);
      const normalizedDomain = normalizeCookieDomain(domainInput.value);
      const activeTab = await getCurrentActiveTab();
      const activeTabContext = getActiveTabUrlContext(activeTab);
      const { cookies } = await readCookiesForDomain(normalizedDomain);
      const localStorageEntries = await readLocalStorageFromActiveTab();
      const profiles = await loadProfiles();
      const nextProfile = createProfile({
        profileName,
        domain: normalizedDomain,
        cookies,
        localStorageEntries,
        activeTabUrl: activeTabContext.url,
        activeTabOrigin: activeTabContext.origin
      });

      profiles.unshift(nextProfile);
      await saveProfiles(profiles);
      renderProfiles(profiles);
      showStatus("Session saved successfully", "success");

      profileNameInput.value = "";
      domainInput.value = "";
      profileNameInput.focus();
    } catch (error) {
      console.error("Failed to save session", error);

      if (error && error.message === "Profile name is required.") {
        profileNameInput.focus();
      }

      if (
        error &&
        (error.message === "Domain is required." || error.message === "Enter a valid domain.")
      ) {
        domainInput.focus();
      }

      showStatus("Failed to save session", "error");
    }
  });

  initializePopup();
});
