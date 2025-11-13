export const loader = () => {
  return new Response(
    `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Privacy Policy | Restocking Report</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.6; color: #222; }
        h1, h2, h3 { color: #0B3D91; }
        a { color: #007BFF; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>Restocking Report – Privacy Policy</h1>
      <p><strong>Effective Date:</strong> November 12, 2025</p>
      <p>Thank you for using <strong>Restocking Report</strong> ("the App"). This Privacy Policy describes how your personal information is collected, used, and shared when you install or use the App in connection with your Shopify store.</p>

      <h2>1. Information We Collect</h2>
      <p>We automatically access certain store data through Shopify’s secure API including store details, inventory data, and order metadata. We do not collect customer personal data such as names or emails.</p>

      <h2>2. How We Use Information</h2>
      <p>We use store and product data solely to provide reporting and analytics functionality for your Shopify store. We do not sell or share this information with third parties.</p>

      <h2>3. Data Retention</h2>
      <p>All store data is deleted automatically within 48 hours of uninstalling the App.</p>

      <h2>4. Data Sharing</h2>
      <p>We only share data as required to comply with legal obligations or maintain App functionality via Shopify’s API.</p>

      <h2>5. Data Security</h2>
      <p>All data is encrypted in transit via HTTPS and authenticated using Shopify OAuth tokens.</p>

      <h2>6. Compliance Requests</h2>
      <p>The App supports Shopify’s <code>customers/data_request</code>, <code>customers/redact</code>, and <code>shop/redact</code> webhooks to ensure privacy law compliance.</p>

      <h2>7. Contact Us</h2>
      <p>Email: <a href="mailto:support@restockingreport.app">support@restockingreport.app</a></p>

      <p><em>This Privacy Policy complies with Shopify’s App Store requirements and GDPR/CCPA standards.</em></p>
    </body>
    </html>
    `,
    {
      headers: { "Content-Type": "text/html" },
    }
  );
};
