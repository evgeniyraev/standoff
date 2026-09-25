// OS-level pairing on Windows, done before Web Bluetooth connects.
//
// The buzzer's RX characteristic needs an encrypted link. Chromium's Web
// Bluetooth does not pair Just Works devices reliably on Windows: the pair
// request stalls and every write fails with "Connection already in progress".
// Pairing the device with Windows first (as "Add device" would) avoids that;
// Web Bluetooth then connects over an already-bonded link.
//
// Electron has no pairing API, so this drives WinRT
// (Windows.Devices.Enumeration custom pairing) from Windows PowerShell 5.1,
// which ships with every Windows 10/11. The ConfirmOnly prompt is accepted in
// code, so no system dialog appears.

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 30000;

// Reflection keeps the C# free of WinRT compile-time references. The pairing
// request must be accepted synchronously inside the event handler, which a
// PowerShell scriptblock cannot do from WinRT's background thread.
const HELPER_CS = `
using System;
using System.Reflection;
public static class StandoffPairing {
  public static string Kind = "";
  public static void Attach(object custom) {
    EventInfo ev = custom.GetType().GetEvent("PairingRequested");
    Delegate d = Delegate.CreateDelegate(ev.EventHandlerType, typeof(StandoffPairing).GetMethod("OnRequested"));
    ev.GetAddMethod().Invoke(custom, new object[] { d });
  }
  public static void OnRequested(object sender, object args) {
    Type t = args.GetType();
    Kind = Convert.ToString(t.GetProperty("PairingKind").GetValue(args, null));
    t.GetMethod("Accept", Type.EmptyTypes).Invoke(args, null);
  }
}`;

// Prints "LOG:<text>" lines and one final "RESULT:<status>" line.
const script = (address, repair) => `
$ErrorActionPreference = 'Stop'
function Say($s) { [Console]::Out.WriteLine($s) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
  $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait(${TIMEOUT_MS - 5000})) { throw 'timed out' }
    $task.Result
  }
  Add-Type -TypeDefinition @'
${HELPER_CS}
'@

  $addr = [Convert]::ToUInt64('${address.replace(/[^0-9a-fA-F]/g, '')}', 16)
  $dev = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($addr)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
  if ($null -eq $dev) { Say 'RESULT:NotFound'; exit }
  $pairing = $dev.DeviceInformation.Pairing
  Say "LOG:Windows device '$($dev.Name)' paired=$($pairing.IsPaired) canPair=$($pairing.CanPair)"

  if ($pairing.IsPaired -and ${repair ? '$true' : '$false'}) {
    $r = Await ($pairing.UnpairAsync()) ([Windows.Devices.Enumeration.DeviceUnpairingResult])
    Say "LOG:Removed old Windows pairing: $($r.Status)"
  } elseif ($pairing.IsPaired) {
    Say 'RESULT:AlreadyPaired'; $dev.Dispose(); exit
  }

  $custom = $pairing.Custom
  [StandoffPairing]::Attach($custom)
  $kinds = [Windows.Devices.Enumeration.DevicePairingKinds]::ConfirmOnly
  $level = [Windows.Devices.Enumeration.DevicePairingProtectionLevel]::Encryption
  $res = Await ($custom.PairAsync($kinds, $level)) ([Windows.Devices.Enumeration.DevicePairingResult])
  if ([StandoffPairing]::Kind) { Say "LOG:Accepted pairing request ($([StandoffPairing]::Kind))" }
  Say "RESULT:$($res.Status)"
  $dev.Dispose()
} catch {
  Say "RESULT:Error $($_.Exception.Message)"
}
`;

/**
 * Makes sure Windows has a bond with the device at `address` ("AA:BB:..").
 * With `repair`, an existing bond is removed first (bond-mismatch recovery).
 * Resolves to { ok, status }; never rejects.
 */
export function ensurePaired(address, { repair = false, log = () => {} } = {}) {
  if (process.platform !== 'win32' || !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(address)) {
    return Promise.resolve({ ok: true, status: 'Skipped' });
  }
  return new Promise((resolve) => {
    const encoded = Buffer.from(script(address, repair), 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let out = '';
    let status = null;
    const timer = setTimeout(() => {
      status = 'Timeout';
      ps.kill();
    }, TIMEOUT_MS);
    ps.stdout.on('data', (chunk) => {
      out += chunk;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line.startsWith('LOG:')) log(line.slice(4));
        else if (line.startsWith('RESULT:')) status = line.slice(7);
      }
    });
    ps.stderr.on('data', (chunk) => log(`powershell: ${String(chunk).trim()}`));
    const done = () => {
      clearTimeout(timer);
      status ??= 'NoResult';
      resolve({ ok: status === 'Paired' || status === 'AlreadyPaired', status });
    };
    ps.on('error', (err) => {
      status = `Error ${err.message}`;
      done();
    });
    ps.on('close', done);
  });
}
