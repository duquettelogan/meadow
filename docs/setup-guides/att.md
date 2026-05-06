# AT&T: Disable DHCP

AT&T fiber and U-verse use **BGW210**, **BGW320**, or **NVG-589**
gateways. AT&T does **not** let you disable DHCP outright — but
they expose an "IP Passthrough" mode that's equivalent (the
gateway hands the public IP off to a single device behind it and
gets out of the way).

For Meadow's purposes, the simpler path is to just disable DHCP
without IP Passthrough — you can do this from the gateway admin
page.

> _Screenshot placeholder — AT&T gateway login._

1. From your phone or laptop on the AT&T Wi-Fi, open
   **http://192.168.1.254** in a browser. (Yes, it's `.254`, not
   `.1` — AT&T is unusual.)
2. Click **Settings → LAN → DHCP**.
3. Find **Device Access Code** — it's an 8-character code on a
   sticker on the side of the gateway. Enter it when prompted.

   > _Screenshot placeholder — DHCP page with Allocation toggle._

4. Set **Allocation** to **Off**, then click **Save**.
5. The gateway may reboot (about 90 seconds). Reconnect your phone
   to Wi-Fi when it comes back.
6. Open **http://meadow.local** and tap **Retry network setup**.

**If "Off" isn't an option** (some firmware versions hide it),
the alternative is **IP Passthrough**:

1. From the same admin page, click **Firewall → IP Passthrough**.
2. Set **Allocation Mode** to **Passthrough**.
3. Set **Passthrough Mode** to **DHCPS-Fixed**.
4. For **Passthrough Fixed MAC Address**, enter the MAC address of
   your Meadow box (printed on a sticker on the box, or in the
   dashboard under "Box health").
5. Click **Save** and let the gateway reboot.
6. Open **http://meadow.local** and tap **Retry network setup**.

Wi-Fi keeps working from the AT&T gateway either way. The only
change is that Meadow is now handling IP-address handouts.
