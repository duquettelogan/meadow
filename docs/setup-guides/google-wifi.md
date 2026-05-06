# Google Wifi / Nest Wifi: Disable DHCP

Google Wifi and Nest Wifi are configured through the **Google Home**
app on your phone. They don't have a web admin page.

> _Screenshot placeholder — Google Home app, Wi-Fi tab._

1. Open the **Google Home** app on your phone.
2. Tap **Wi-Fi** in the bottom navigation.
3. Tap the **Settings** gear (top right), then **Advanced
   networking**.
4. Tap **LAN settings**, then **DHCP IP reservations** — make sure
   any reservations you care about are noted (you'll re-create them
   on the new DHCP server later if needed).

   > _Screenshot placeholder — LAN settings page._

5. Back out one screen. Tap **WAN**, then change the connection mode
   to **Bridge mode** (this disables DHCP and NAT on your Google
   Wifi).
6. Tap **Save**. The mesh will restart — Wi-Fi drops for about 60
   seconds.
7. After your phone reconnects, open **http://meadow.local** and tap
   **Retry network setup**.

**One catch:** Google Wifi in bridge mode only supports a single
puck. If you have multiple pucks set up as a mesh, switching to
bridge mode will turn off all but the primary one. If that's a
problem (e.g., dead Wi-Fi spots in the house), email
**support@dqsec.com** before doing this — there are two-router
configurations that keep the mesh working.
