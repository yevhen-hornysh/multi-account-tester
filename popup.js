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

  function getActiveTab() {
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

        if (!activeTab.url) {
          reject(new Error("The active tab does not have a readable URL."));
          return;
        }

        resolve(activeTab);
      });
    });
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
    const activeTab = await getActiveTab();

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
      activateButton.addEventListener("click", () => {
        console.log("Activate profile placeholder", profile);
        showStatus(`Activate is not implemented for "${profile.profileName}" yet.`);
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
      const activeTab = await getActiveTab();
      const activeTabOrigin = new URL(activeTab.url).origin;
      const { cookies } = await readCookiesForDomain(normalizedDomain);
      const localStorageEntries = await readLocalStorageFromActiveTab();
      const profiles = await loadProfiles();
      const nextProfile = createProfile({
        profileName,
        domain: normalizedDomain,
        cookies,
        localStorageEntries,
        activeTabUrl: activeTab.url,
        activeTabOrigin
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
