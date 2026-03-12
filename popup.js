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

  saveSessionButton.addEventListener("click", async () => {
    const profileName = profileNameInput.value.trim();
    const domain = domainInput.value.trim();

    if (!profileName) {
      showStatus("Profile name is required.", "error");
      profileNameInput.focus();
      return;
    }

    if (!domain) {
      showStatus("Domain is required.", "error");
      domainInput.focus();
      return;
    }

    try {
      const profiles = await loadProfiles();
      const nextProfile = {
        id: crypto.randomUUID(),
        profileName,
        domain,
        savedAt: new Date().toISOString()
      };

      profiles.unshift(nextProfile);
      await saveProfiles(profiles);
      renderProfiles(profiles);

      try {
        const { normalizedDomain, cookies } = await readCookiesForDomain(domain);
        console.log(`Cookies for ${normalizedDomain}`, cookies);
        showStatus(`Saved profile "${nextProfile.profileName}". Found ${cookies.length} cookies.`, "success");
      } catch (cookieError) {
        console.error("Failed to read cookies for domain", domain, cookieError);
        showStatus(
          `Saved profile "${nextProfile.profileName}", but cookie lookup failed.`,
          "error"
        );
      }

      profileNameInput.value = "";
      domainInput.value = "";
      profileNameInput.focus();
    } catch (error) {
      console.error("Failed to save profile metadata", error);
      showStatus("Failed to save profile.", "error");
    }
  });

  initializePopup();
});
