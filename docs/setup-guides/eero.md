# eero: Disable DHCP

eero is configured exclusively through the **eero app** on your
phone — there's no web admin page to log into.

> _Screenshot placeholder — eero app home screen._

1. Open the **eero** app on your phone (the same one you used to set
   up your eero originally).
2. Tap **Settings** in the bottom toolbar.
3. Tap **Network Settings**, then **DHCP & NAT**.

   > _Screenshot placeholder — DHCP & NAT options._

4. Tap **DHCP & NAT mode** and choose **Bridge** mode.
5. Tap **Save**. Your eero will restart (this takes about a minute) —
   Wi-Fi will go down briefly while it reboots.
6. Once your phone reconnects to Wi-Fi, open **http://meadow.local**
   and tap **Retry network setup**.

**Heads up — bridge mode disables a few eero features:** the
**eero Secure** filter, **family profiles**, **port forwarding**, and
**reservations**. You don't need any of those when running Meadow —
Meadow handles the filtering side, and your modem (the device your
eero plugs into) keeps doing the routing.

If your eero is ALSO your modem (eero from your ISP), bridge mode
isn't available. Email **support@dqsec.com** with a photo of the back
of your eero and we'll work out the right path.
