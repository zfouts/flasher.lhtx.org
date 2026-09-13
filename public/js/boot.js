/**
 * Runs before the app module and is deliberately plain: no imports, no
 * modern syntax, nothing that a browser too old for the rest of this tool
 * would choke on.
 *
 * Its whole job is to hide the "this browser can't reach a radio" warning
 * once the browser proves otherwise. The warning is visible in the markup by
 * default, so if this file, or app.js, or module support itself is missing,
 * the visitor is still told rather than handed a page that silently does
 * nothing. This is a classic script, not a module, for the same reason.
 */
(function () {
  var n = navigator;
  var serial = !!(n.serial && typeof n.serial.requestPort === 'function');
  var ble = !!(n.bluetooth && typeof n.bluetooth.requestDevice === 'function');
  var box = document.getElementById('unsupported');
  if (box && (serial || ble)) box.hidden = true;
})();
