# ASUS: Disable DHCP

ASUS routers (RT-, ZenWiFi, AiMesh) all share the ASUSWRT admin
interface. The DHCP toggle is in the LAN settings.

> _Screenshot placeholder — ASUSWRT login screen._

1. From a device on the ASUS's Wi-Fi, open **http://router.asus.com**
   (or **http://192.168.50.1**).
2. Sign in with the admin password (printed on a sticker on the
   bottom of the router if you've never changed it).
3. In the left menu, click **LAN**, then the **DHCP Server** tab at
   the top.

   > _Screenshot placeholder — LAN → DHCP Server tab with the "Enable
   > the DHCP Server" toggle._

4. Find **"Enable the DHCP Server"** and switch it to **No**.
5. Scroll to the bottom and click **Apply**. The router will save —
   it usually doesn't need to restart.
6. Go back to **http://meadow.local** and tap **Retry network setup**.

Your ASUS will keep handling Wi-Fi and routing internet traffic
normally. The only change is that Meadow now hands out IP addresses
instead.
