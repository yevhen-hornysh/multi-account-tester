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
      deleteButton.addEventListener("click", () => {
        console.log("Delete profile placeholder", profile);
        showStatus(`Delete is not implemented for "${profile.profileName}" yet.`);
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

      profileNameInput.value = "";
      domainInput.value = "";
      profileNameInput.focus();

      showStatus(`Saved profile "${nextProfile.profileName}".`, "success");
    } catch (error) {
      console.error("Failed to save profile metadata", error);
      showStatus("Failed to save profile.", "error");
    }
  });

  initializePopup();
});
