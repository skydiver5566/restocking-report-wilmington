// app/routes/webhooks.compliance.jsx

export const loader = () => {
  return new Response("OK", { status: 200 });
};

export const action = async ({ request, context }) => {
  try {
    const { topic, shop } = context.webhook;

    console.log("Received compliance webhook:", topic, "from", shop);

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response("Invalid webhook", { status: 400 });
  }
};
