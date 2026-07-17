Extract the following fields from the invoice below and return them as a single JSON object with exactly these keys:

- "vendor": the issuing company name as written on the invoice
- "invoice_number": the invoice identifier
- "total": the total amount due as a number, no currency symbol
- "due_date": the payment due date in YYYY-MM-DD format

Return only the JSON object, no explanation.

Invoice:

{{input}}
