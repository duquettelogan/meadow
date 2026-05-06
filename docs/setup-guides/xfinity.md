# Xfinity: Disable DHCP

Xfinity (Comcast) ships **xFi Gateways** (XB6, XB7, XB8). These
**don't expose a DHCP toggle** in the web admin or the xFi app —
Comcast removed it.

The supported workaround is **bridge mode**, which disables DHCP and
routing on the gateway. Your gateway becomes a pure modem; you'll
need a separate router for Wi-Fi.

> _Screenshot placeholder — xFi app home screen._

1. Open the **xFinity** app on your phone (the orange one, not
   xFinity Home).
2. Tap **Connect** at the bottom, then **See Network**.
3. Tap your gateway, then **Advanced Settings**.
4. Tap **Bridge Mode**, then toggle it **on**.

   > _Screenshot placeholder — Bridge mode toggle in xFi app._

5. Confirm the warning (it tells you Wi-Fi from the gateway will
   stop working). Tap **OK**.
6. Plug a separate Wi-Fi router into one of the gateway's ethernet
   ports. Set up Wi-Fi on that router as you normally would.
7. Plug the Meadow box into another ethernet port on the new
   router (or directly into the gateway if you don't have a router
   yet — Meadow can do basic DHCP, but you'll have no Wi-Fi).
8. Once everything's connected, open **http://meadow.local** and tap
   **Retry network setup**.

**Don't have a separate router?** Email **support@dqsec.com** —
we'll point you at a $50–80 option that works well with Meadow. Most
households end up here once Comcast pushes them off the older XB3.

**Reverting:** to turn bridge mode back off, follow steps 1-5 again
and toggle it **off**. Wi-Fi from the gateway will come back.
