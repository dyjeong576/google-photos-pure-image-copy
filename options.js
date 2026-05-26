const DEFAULT_SITES = [
  {
    host: "photos.google.com",
    enabled: true
  },
  {
    host: "drive.google.com",
    enabled: true
  },
  {
    host: "www.icloud.com",
    enabled: true
  },
  {
    host: "www.instagram.com",
    enabled: true
  },
  {
    host: "www.facebook.com",
    enabled: true
  },
  {
    host: "www.notion.so",
    enabled: true
  }
];
const DEFAULT_SITES_VERSION = 2;
const DEFAULT_SITE_HOSTS = new Set(DEFAULT_SITES.map((site) => site.host));
const DEFAULT_IMAGE_QUALITY = "high";
const IMAGE_QUALITY_VALUES = new Set(["low", "normal", "high"]);

const siteList = document.getElementById("site-list");
const addForm = document.getElementById("add-form");
const siteInput = document.getElementById("site-input");
const addButton = document.getElementById("add-button");
const message = document.getElementById("message");
const heading = document.getElementById("heading");
const headingDescription = document.getElementById("heading-description");
const settingsTitle = document.getElementById("settings-title");
const settingsDescription = document.getElementById("settings-description");
const languageLabel = document.getElementById("language-label");
const languageSelect = document.getElementById("language-select");
const qualityLabel = document.getElementById("quality-label");
const qualitySelect = document.getElementById("quality-select");
const siteInputLabel = document.getElementById("site-input-label");
const siteListTitle = document.getElementById("site-list-title");
const siteListDescription = document.getElementById("site-list-description");
const emptyState = document.getElementById("empty-state");

let sites = [];
let language = I18N.defaultLanguage;
let imageQuality = DEFAULT_IMAGE_QUALITY;

init();

languageSelect.addEventListener("change", async () => {
  language = languageSelect.value;
  await chrome.storage.sync.set({ language });
  renderLanguage();
  renderSites();
  setMessage(t("saved"));
});

qualitySelect.addEventListener("change", async () => {
  imageQuality = getImageQuality(qualitySelect.value);
  await chrome.storage.sync.set({ imageQuality });
  renderLanguage();
  setMessage(t("saved"));
});

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  let host;
  try {
    host = normalizeHost(siteInput.value);
  } catch (error) {
    setMessage(error.message, "error");
    return;
  }

  if (sites.some((site) => isSameSiteHost(site.host, host))) {
    setMessage(t("duplicateSite"), "error");
    return;
  }

  const granted = await chrome.permissions.request({
    origins: getPermissionOrigins(host)
  });

  if (!granted) {
    setMessage(t("permissionDenied"), "error");
    return;
  }

  sites.push({
    host,
    enabled: true
  });
  siteInput.value = "";
  await saveSites();
  renderSites();
  setMessage(t("added"));
});

async function init() {
  renderLanguageOptions();
  const stored = await chrome.storage.sync.get(["sites", "language", "defaultSitesVersion", "imageQuality"]);
  sites = await getSites(stored);
  language = getLanguage(stored.language);
  imageQuality = getImageQuality(stored.imageQuality);
  renderLanguage();
  renderSites();
}

async function getSites(stored) {
  if (Array.isArray(stored.sites) && stored.sites.length > 0) {
    if (stored.defaultSitesVersion !== DEFAULT_SITES_VERSION) {
      const mergedSites = mergeDefaultSites(stored.sites);
      await chrome.storage.sync.set({
        sites: mergedSites,
        defaultSitesVersion: DEFAULT_SITES_VERSION
      });
      return mergedSites;
    }

    return stored.sites;
  }

  await chrome.storage.sync.set({
    sites: DEFAULT_SITES,
    defaultSitesVersion: DEFAULT_SITES_VERSION
  });
  return DEFAULT_SITES.slice();
}

async function saveSites() {
  await chrome.storage.sync.set({ sites });
}

function mergeDefaultSites(storedSites) {
  const hosts = new Set(storedSites.map((site) => site.host));
  return storedSites.concat(DEFAULT_SITES.filter((site) => !hosts.has(site.host)));
}

async function removeOptionalHostPermission(host) {
  if (DEFAULT_SITE_HOSTS.has(host)) {
    return;
  }

  await chrome.permissions.remove({
    origins: getPermissionOrigins(host)
  });
}

function renderLanguageOptions() {
  languageSelect.textContent = "";

  I18N.languages.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.code;
    option.textContent = item.label;
    languageSelect.append(option);
  });
}

function renderQualityOptions() {
  qualitySelect.textContent = "";

  [
    ["low", "qualityLow"],
    ["normal", "qualityNormal"],
    ["high", "qualityHigh"]
  ].forEach(([value, labelKey]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(labelKey);
    qualitySelect.append(option);
  });
}

function renderLanguage() {
  document.title = t("pageTitle");
  heading.textContent = t("heading");
  headingDescription.textContent = t("headingDescription");
  settingsTitle.textContent = t("settingsTitle");
  settingsDescription.textContent = t("settingsDescription");
  languageLabel.textContent = t("languageLabel");
  qualityLabel.textContent = t("qualityLabel");
  siteInputLabel.textContent = t("siteInputLabel");
  siteInput.placeholder = t("siteInputPlaceholder");
  addButton.textContent = t("addButton");
  siteListTitle.textContent = t("siteListTitle");
  siteListDescription.textContent = t("siteListDescription");
  emptyState.textContent = t("emptyState");
  languageSelect.value = language;
  renderQualityOptions();
  qualitySelect.value = imageQuality;
}

function renderSites() {
  siteList.textContent = "";
  emptyState.hidden = sites.length > 0;

  sites.forEach((site, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const host = document.createElement("span");
    const removeButton = document.createElement("button");

    checkbox.type = "checkbox";
    checkbox.checked = site.enabled;
    checkbox.addEventListener("change", async () => {
      sites[index].enabled = checkbox.checked;
      await saveSites();
      setMessage(t("saved"));
    });

    host.textContent = site.host;

    removeButton.type = "button";
    removeButton.textContent = t("removeButton");
    removeButton.addEventListener("click", async () => {
      if (sites.length <= 1) {
        setMessage(t("minimumSites"), "error");
        return;
      }

      const [removedSite] = sites.splice(index, 1);
      await saveSites();
      await removeOptionalHostPermission(removedSite.host);
      renderSites();
      setMessage(t("removed"));
    });

    label.append(checkbox, host);
    item.append(label, removeButton);
    siteList.append(item);
  });
}

function normalizeHost(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(t("urlRequired"));
  }

  let url;
  try {
    const normalizedInput = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    url = new URL(normalizedInput);
  } catch {
    throw new Error(t("invalidUrl"));
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(t("unsupportedProtocol"));
  }

  if (!url.hostname || url.username || url.password) {
    throw new Error(t("invalidUrl"));
  }

  return url.hostname.toLowerCase();
}

function getRelatedHosts(host) {
  if (host.startsWith("www.")) {
    return [host, host.slice(4)];
  }

  if (host.includes(".") && !isIpAddress(host)) {
    return [host, `www.${host}`];
  }

  return [host];
}

function getPermissionOrigins(host) {
  return getRelatedHosts(host).flatMap((relatedHost) => [
    `http://${relatedHost}/*`,
    `https://${relatedHost}/*`
  ]);
}

function isSameSiteHost(host, otherHost) {
  return getRelatedHosts(host).includes(otherHost) || getRelatedHosts(otherHost).includes(host);
}

function isIpAddress(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function setMessage(text, type = "success") {
  message.textContent = text;
  message.dataset.type = type;
}

function getLanguage(value) {
  return I18N.messages[value] ? value : I18N.defaultLanguage;
}

function getImageQuality(value) {
  return IMAGE_QUALITY_VALUES.has(value) ? value : DEFAULT_IMAGE_QUALITY;
}

function t(key) {
  const messages = I18N.messages[language] || I18N.messages[I18N.defaultLanguage];
  return messages[key] || I18N.messages[I18N.defaultLanguage][key] || key;
}
