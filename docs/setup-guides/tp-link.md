# TP-Link: Disable DHCP

TP-Link routers (Archer, Deco, TL-) use the **tplinkwifi.net** admin
page. The DHCP toggle is in the network settings.

> _Screenshot placeholder — tplinkwifi.net login._

1. From your phone or laptop connected to the TP-Link Wi-Fi, open
   **http://tplinkwifi.net** (or **http://192.168.0.1** /
   **http://192.168.1.1**).
2. Log in. The default password is on a sticker on the router; if
   you've changed it, use yours.
3. Click **Advanced** at the top, then **Network → DHCP Server** in
   the left menu.

   > _Screenshot placeholder — DHCP Server page with the "DHCP Server"
   > on/off toggle._

4. Set **DHCP Server** to **Disable**.
5. Click **Save**. The router will commit the change immediately.
6. Open **http://meadow.local** and tap **Retry network setup**.

You're done. Wi-Fi and internet keep working — only the IP-address
hand-out has changed.

**Deco mesh users:** the same setting lives in the Deco app under
**More → Advanced → DHCP Server**. Toggle it off and tap **Save**.
