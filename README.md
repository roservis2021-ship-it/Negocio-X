# Tiketek

Venta rápida de entradas para fiestas y eventos.
Flujo: **elegir evento → elegir entradas → pago → confirmación**.

## Qué incluye

- **Confirmación por email** desde el dominio verificado de Tiketek: una entrada por persona con **código QR único firmado** (`TKT1.<id>.<firma>`), desglose del primer cobro, cuota recurrente y enlace de gestión/cancelación. Sin `RESEND_API_KEY`, los emails se guardan en `outbox/`. Si un envío falla, se reintenta solo.

- **Checkout de Stripe** (`/pago` → Stripe Checkout): cobra ahora solo las entradas y programa la suscripción de **112 €/mes** para comenzar un mes después del pago. Stripe guarda el método de pago con autorización para futuros cargos y procesa las cuotas mensuales hasta la cancelación.
- **Suscripción por pedido**: se crea una sola suscripción mensual por compra. El cliente puede cambiar su método de pago o cancelar renovaciones desde el portal seguro de Stripe, con verificación del email de compra.
- **Webhook de Stripe** como fuente de verdad: el pedido queda pagado aunque el cliente cierre la página.
- **Firebase Firestore** como base de datos, accedida solo desde el servidor (Admin SDK). Las reglas de Firestore bloquean cualquier acceso desde el navegador.
- **Aforo por tipo de entrada** controlado con transacciones de Firestore (no se vende de más aunque compren muchos a la vez), con reserva temporal (35 min) mientras el cliente paga. Las reservas caducadas se liberan y la sesión de Stripe se cierra.
- **Seguridad**: HTTPS obligatorio, cabeceras de seguridad y CSP (helmet), límite de peticiones y precios siempre calculados en el servidor.
- **Legal**: condiciones de compra, privacidad y aviso legal, con aceptación obligatoria antes de pagar. Tipografías servidas desde el propio dominio (sin Google Fonts, por el RGPD).

## Antes de publicar

1. **Rellena los textos legales** en `public/legal/`: los campos marcados en amarillo (`class="fill"`) llevan tus datos y beneficios del plan (razón social, NIF, dirección, email, beneficios concretos, tratamiento de impuestos…). Conviene que los revise un asesor. El servidor bloquea el inicio en producción si siguen pendientes datos legales o los eventos de muestra.
2. **Completa los dos eventos del catálogo** en `data/events.json`: añade fecha, recinto, ciudad, aforo y beneficios; después activa `saleEnabled`. Las entradas cuestan 35 € y 60 €. Los importes van en céntimos y el servidor valida el archivo al arrancar.
3. **Activa tu cuenta de Stripe** para cobros reales (datos fiscales y cuenta bancaria) en https://dashboard.stripe.com.
4. **Crea el webhook** en Stripe → Developers → Webhooks:
   - URL: `https://TU-DOMINIO/api/stripe/webhook`
   - Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - Copia el *signing secret* (`whsec_...`).
5. **Configura Firebase**:
   - Crea un proyecto en https://console.firebase.google.com y activa **Firestore** (ubicación recomendada: `eur3` o `europe-west`).
   - Publica `firestore.rules` (todo cerrado): `firebase deploy --only firestore:rules --project TU_PROYECTO`.
   - En Configuración del proyecto → Cuentas de servicio, genera una clave privada y guarda su contenido en `FIREBASE_SERVICE_ACCOUNT`.
6. En Stripe, configura el portal del cliente y habilita la cancelación al final del periodo (`at_period_end`). Comprueba la política de prorrateo y activa los emails de facturas/recibos y avisos de pago fallido para renovaciones.
7. Verifica el dominio de envío en Resend y configura `EMAIL_FROM` con una dirección del dominio de Tiketek. El email de compra incluye las entradas y un enlace para gestionar o cancelar la suscripción.

## Variables de entorno

Ver `.env.example`. Obligatorias: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TICKET_SECRET` y credenciales de Firestore. Para producción con ventas activas también se exige `RESEND_API_KEY`. Usa `SALES_ENABLED=false` durante el despliegue inicial hasta configurar el webhook y el correo.

## Desplegar en Render

`render.yaml` define el servicio. Como los datos están en Firestore no necesita disco; se recomienda el plan starter para que el servidor no se duerma.

1. Sube la carpeta `tiketek` a un repositorio Git.
2. En Render: **New → Blueprint** y elige el repositorio.
3. Rellena las variables de Stripe y `FIREBASE_SERVICE_ACCOUNT`.
4. Añade tu dominio en Render → Settings → Custom Domains.

Cualquier hosting con Node 24 sirve igual (`npm ci --omit=dev` y `npm start`).

## Ejecutar en local

```bash
npm install
npm run dev
```

Necesita un `.env` con una clave de prueba de Stripe, Firebase/Firestore Emulator y `TICKET_SECRET`. En local los emails se guardan en `outbox/`. Para probar el webhook sin cobrar, usa Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Configura `monthlyPrice` (en céntimos; 11200 = 112,00 €) y `subscriptionBenefits` en cada evento de `data/events.json` antes de vender. Los eventos actuales aparecen en la web como próximos; no se pueden comprar hasta añadir sus datos pendientes y activar la venta.

## Estructura

- `server.js`: API, pagos, webhook, seguridad y servidor web.
- `db.js`: acceso a Firestore (`orders`, `stock`, `tickets`) y control de aforo.
- `billing.js`: cobros en Stripe.
- `emails.js` / `mailer.js`: contenido de los emails (con QR) y envío (Resend u `outbox/`).
- `firestore.rules`: reglas de seguridad de Firestore.
- `data/events.json`: catálogo de eventos.
- `public/`: páginas `index`, `evento`, `pago`, `exito` y `legal/`.

## Pendiente

- Lector de QR para validar las entradas en la puerta.
- Configurar Resend con el dominio propio para enviar los emails de verdad.
- Panel de administración para crear eventos y ver ventas.
- Copias de seguridad programadas de Firestore (Firebase Console → Firestore → Copias de seguridad).
