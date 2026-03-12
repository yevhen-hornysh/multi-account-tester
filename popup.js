document.addEventListener("DOMContentLoaded", () => {
  const profileNameInput = document.getElementById("profileName");
  const domainInput = document.getElementById("domain");
  const saveSessionButton = document.getElementById("saveSessionButton");
  const profilesList = document.getElementById("profilesList");
  const statusMessage = document.getElementById("statusMessage");

  let statusTimeoutId;

  function showStatus(message) {
    window.clearTimeout(statusTimeoutId);
    statusMessage.textContent = message;
    statusMessage.classList.add("is-visible");

    statusTimeoutId = window.setTimeout(() => {
      statusMessage.textContent = "";
      statusMessage.classList.remove("is-visible");
    }, 1800);
  }

  saveSessionButton.addEventListener("click", () => {
    const profileName = profileNameInput.value.trim();
    const domain = domainInput.value.trim();

    console.log("Save clicked", {
      profileName,
      domain,
      profilesListReady: Boolean(profilesList)
    });

    showStatus("Save clicked");
  });
});
