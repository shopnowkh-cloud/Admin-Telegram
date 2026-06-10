const API_KEY = "3dd71200967c1afb2a82bf21ee9c138c";
const BASE_URL = "https://sms-x.org/stubs/handler_api.php";

async function getNumber() {
  const url = `${BASE_URL}?api_key=${API_KEY}&action=getNumber&service=ot&server=10`;
  const res = await fetch(url);
  const text = await res.text();
  console.log("getNumber response:", text);
  if (text.startsWith("ACCESS_NUMBER")) {
    const parts = text.split(":");
    return { id: parts[1], phone: parts[2] };
  }
  throw new Error(`Failed to get number: ${text}`);
}

async function getStatus(id) {
  const url = `${BASE_URL}?api_key=${API_KEY}&action=getStatus&id=${id}`;
  const res = await fetch(url);
  const text = await res.text();
  console.log(`getStatus [${id}] response:`, text);
  return text;
}

async function waitForSms(id, timeoutMs = 120000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getStatus(id);
    if (status.startsWith("STATUS_OK")) {
      const code = status.split(":")[1];
      return code;
    }
    if (status === "STATUS_CANCEL") {
      throw new Error("Number was cancelled");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for SMS");
}

async function main() {
  console.log("Requesting number...");
  const { id, phone } = await getNumber();
  console.log(`Got number: ${phone} (id: ${id})`);

  console.log("Waiting for SMS code...");
  const code = await waitForSms(id);
  console.log(`Received SMS code: ${code}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
