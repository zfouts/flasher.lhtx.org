/**
 * Turns "the radio didn't answer" into something a person can act on.
 *
 * Detection can fail for reasons that all look identical on the wire, so
 * the message is chosen from what actually arrived:
 *
 *   nothing at all   -> the firmware on the other end is not listening on
 *                       USB: a bootloader (DFU mode), or the Bluetooth
 *                       companion build, which has no USB interface at all
 *                       (ENABLE_USB_INTERFACE is only set in *_companion_radio_usb).
 *   unrecognised     -> something is talking, but not MeshCore in a mode this
 *                       tool knows: non-MeshCore firmware, a debug build, or
 *                       a board still mid-boot.
 */

/**
 * @param {object} stats
 * @param {number} stats.rxBytes   bytes received since the port opened
 * @param {string} stats.excerpt   printable rendering of the first of them
 * @param {string} stats.usbId     "vvvv:pppp" or ''
 * @returns {{ message: string, hints: string[], detail: string }}
 */
export function explainNoAnswer({ rxBytes = 0, excerpt = '', usbId = '' } = {}) {
  const detail = usbId ? `USB id ${usbId}` : '';

  if (rxBytes === 0) {
    return {
      message: 'Connected, but the radio sent nothing at all.',
      hints: [
        'Is it in DFU / bootloader mode? That is only for flashing. Unplug it and plug it back in (or press its reset button once) so MeshCore boots normally. The screen, if it has one, should show the node name.',
        'Companion radios: the Bluetooth companion firmware does not talk over USB at all. Use "Connect over Bluetooth", or flash the Companion USB firmware instead.',
        'Make sure nothing else has the port open: the MeshCore app, the flasher tab, a serial monitor.',
      ],
      detail: [detail, '0 bytes received'].filter(Boolean).join(' · '),
    };
  }

  return {
    message: "Connected, and the radio is sending data, but not anything this tool recognises.",
    hints: [
      'Check that MeshCore repeater, room server or Companion USB firmware is flashed, not Meshtastic or another project.',
      'If the radio was still booting, try again: it takes a few seconds after plugging in.',
    ],
    detail: [detail, `${rxBytes} bytes received`, excerpt ? `it said: "${excerpt}"` : '']
      .filter(Boolean).join(' · '),
  };
}
