const hidden = new Set<string>();

/** 智能设备：原版无模块开关也无一级；默认侧栏不挂，可用 localStorage/VITE 打开 */
function showIotMenu() {
  try {
    if (import.meta.env.VITE_SHOW_IOT_MENU === '1') return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('VITE_SHOW_IOT_MENU') === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function setHiddenModules(flags: { produce_module?: boolean; device_module?: boolean; aftersales_module?: boolean }) {
  hidden.clear();
  if (flags.produce_module === false) hidden.add('produce');
  // 设备维保：严格跟随企业「设备维保模块」开关（关=不渲染一级）
  if (flags.device_module === false) hidden.add('device');
}

export function moduleHidden(key: string) {
  if (key === 'iot' && !showIotMenu()) return true;
  return hidden.has(key);
}
