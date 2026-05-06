# Netgear: Disable DHCP

Most Netgear routers (Nighthawk, Orbi, R-series) use the same admin
page. If your screen looks different, the setting is in the same
place — under LAN settings.

> _Screenshot placeholder — Netgear admin login page._

1. On a phone or laptop connected to the Netgear's Wi-Fi, open a web
   browser and go to **http://www.routerlogin.net** (or
   **http://192.168.1.1**).
2. Log in. The default username is usually **admin** and the password
   is on a sticker on the back of the router. If you've changed it,
   use that.
3. Click **Advanced** in the top menu, then **Setup → LAN Setup** in
   the left sidebar.

   > _Screenshot placeholder — LAN Setup page with the "Use Router as
   > DHCP Server" checkbox._

4. Find the box labeled **"Use Router as DHCP Server"** and **uncheck
   it**.
5. Click **Apply** at the top right. Your router will save and may
   reboot for a minute.
6. Go back to **http://meadow.local** on your phone and tap **Retry
   network setup**.

That's it. Your Netgear will keep doing Wi-Fi and the internet exactly
like before — Meadow is now the only thing handing out network
addresses.
