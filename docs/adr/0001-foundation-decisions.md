# ADR 0001 — decisiones de la fundación V01

Estado: aceptada · 2026-09-20.

1. El límite de producto es Gmail → obligaciones con evidencia → notificaciones Telegram. Chat, Calendar, contratos, gastos, OCR, WhatsApp, embeddings y grafo quedan fuera de la fundación.
2. PostgreSQL será autoridad; Redis/BullMQ sólo transportará trabajo recuperable desde outbox transaccional. Las fallas entre commit y cola se recuperan leyendo outbox.
3. La identidad local se autentica con credenciales locales, contraseña hasheada y sesión opaca de servidor. OAuth Gmail se administra como conexión de fuente independiente.
4. Los valores de dinero, vencimiento, evidencia, envelope de eventos y payloads se validan con schemas Zod compartidos antes de llegar a servicios. Cambios incompatibles requieren una versión de contrato nueva.
5. Una entrega debe cambiar `README.md`. CI compara la entrega con su base y falla si faltan instrucciones de uso o verificación actualizadas.
