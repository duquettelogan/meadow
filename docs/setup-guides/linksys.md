# Linksys: Disable DHCP

Linksys routers (Velop, EA, MR) use either the Linksys Smart Wi-Fi
admin page or the Linksys app. Both expose the DHCP toggle.

> _Screenshot placeholder — Linksys Smart Wi-Fi login._

## On the web admin page

1. From a device on the Linksys Wi-Fi, open
   **http://192.168.1.1** in a browser.
2. Log in. The default password is **admin** unless you changed it.
3. Click **Connectivity** in the menu, then the **Local Network**
   tab.

   > _Screenshot placeholder — Local Network → DHCP Server section._

4. Uncheck **DHCP Server: Enabled**.
5. Click **OK** to save.
6. Open **http://meadow.local** on your phone and tap **Retry network
   setup**.

## In the Linksys app

1. Open the **Linksys** app on your phone.
2. Tap the menu (☰), then **Network Administration → Local Network
   Settings**.
3. Toggle **DHCP Server** off, then tap **Save**.
4. Go to **http://meadow.local** in your browser and tap **Retry
   network setup**.

Your Linksys keeps handling Wi-Fi and internet exactly as before —
the only thing changing is that Meadow now hands out IP addresses.
