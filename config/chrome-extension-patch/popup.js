document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("savePort").addEventListener("click", savePort);
  document.getElementById("saveProfileLabel").addEventListener("click", saveProfileLabel);
  document.getElementById("clearProfileLabel").addEventListener("click", clearProfileLabel);
  refreshBridgeStatus();
});

async function refreshBridgeStatus() {
  const status = document.getElementById("bridgeStatus");
  const portInput = document.getElementById("port");
  try {
    const resp = await chrome.runtime.sendMessage({ cmd: "status" });
    if (!resp?.ok) throw new Error(resp?.error || "unknown");
    const data = resp.data || {};
    portInput.value = data.wsPort || 18765;
    status.textContent = `状态: ${data.wsConnected ? "已连接" : "未连接"} ${data.wsUrl || ""}`;
    const fileAccessStatus = document.getElementById("fileAccessStatus");
    fileAccessStatus.textContent = `文件网址访问: ${data.fileSchemeAccess ? "已启用" : "未启用"}`;
    fileAccessStatus.className = data.fileSchemeAccess ? "status" : "error";
    renderProfileStatus(data);
  } catch (error) {
    status.textContent = `状态读取失败: ${error.message}`;
    status.className = "error";
    const fileAccessStatus = document.getElementById("fileAccessStatus");
    fileAccessStatus.textContent = `文件网址权限读取失败: ${error.message}`;
    fileAccessStatus.className = "error";
    const profileStatus = document.getElementById("profileStatus");
    profileStatus.textContent = `Profile 读取失败: ${error.message}`;
    profileStatus.className = "error";
  }
}

function renderProfileStatus(data) {
  const profileStatus = document.getElementById("profileStatus");
  const profileLabelInput = document.getElementById("profileLabel");
  const profileId = data.profileId || "-";
  const browserId = data.browserId || "-";
  const label = data.profileLabel || "";
  profileLabelInput.value = label;
  profileStatus.textContent = `Profile: ${label || "(未设置)"} / ${profileId} / ${browserId}`;
  profileStatus.className = "status";
}

async function saveProfileLabel() {
  await setProfileLabel(document.getElementById("profileLabel").value);
}

async function clearProfileLabel() {
  document.getElementById("profileLabel").value = "";
  await setProfileLabel(null);
}

async function setProfileLabel(label) {
  const profileMsg = document.getElementById("profileMsg");
  try {
    const resp = await chrome.runtime.sendMessage({ cmd: "setProfileLabel", label });
    if (!resp?.ok) throw new Error(resp?.error || "unknown");
    profileMsg.textContent = `Success: Profile Label ${resp.data?.profileLabel || "已清空"}`;
    profileMsg.className = "status";
    await refreshBridgeStatus();
  } catch (error) {
    profileMsg.textContent = `保存失败: ${error.message}`;
    profileMsg.className = "error";
  }
}

async function savePort() {
  const portInput = document.getElementById("port");
  const portMsg = document.getElementById("portMsg");
  try {
    const port = Number(portInput.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1-65535");
    if (port === 18767) throw new Error("18767 是 agent-browser-cli API 端口，请换一个插件端口");
    const resp = await chrome.runtime.sendMessage({ cmd: "setPort", port });
    if (!resp?.ok) throw new Error(resp?.error || "unknown");
    portMsg.textContent = `Success: 已保存端口 ${port}，正在使用新端口重连`;
    portMsg.className = "status";
    await refreshBridgeStatus();
  } catch (error) {
    portMsg.textContent = `保存失败: ${error.message}`;
    portMsg.className = "error";
  }
}
