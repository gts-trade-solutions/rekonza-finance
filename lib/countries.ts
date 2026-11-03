// Countries an international customer or vendor can be in: the two-letter ISO
// code that is stored, the name shown, and the currency it usually invoices in
// (offered as the default, and changeable).

export interface Country { code: string; name: string; currency: string }

const TABLE = `
AF|Afghanistan|AFN
AL|Albania|ALL
DZ|Algeria|DZD
AO|Angola|AOA
AR|Argentina|ARS
AM|Armenia|AMD
AU|Australia|AUD
AT|Austria|EUR
AZ|Azerbaijan|AZN
BH|Bahrain|BHD
BD|Bangladesh|BDT
BY|Belarus|BYN
BE|Belgium|EUR
BJ|Benin|XOF
BT|Bhutan|BTN
BO|Bolivia|BOB
BA|Bosnia and Herzegovina|BAM
BW|Botswana|BWP
BR|Brazil|BRL
BN|Brunei|BND
BG|Bulgaria|BGN
BF|Burkina Faso|XOF
KH|Cambodia|KHR
CM|Cameroon|XAF
CA|Canada|CAD
CL|Chile|CLP
CN|China|CNY
CO|Colombia|COP
CD|Congo (DRC)|CDF
CR|Costa Rica|CRC
CI|Côte d’Ivoire|XOF
HR|Croatia|EUR
CU|Cuba|CUP
CY|Cyprus|EUR
CZ|Czechia|CZK
DK|Denmark|DKK
DJ|Djibouti|DJF
DO|Dominican Republic|DOP
EC|Ecuador|USD
EG|Egypt|EGP
SV|El Salvador|USD
EE|Estonia|EUR
ET|Ethiopia|ETB
FJ|Fiji|FJD
FI|Finland|EUR
FR|France|EUR
GA|Gabon|XAF
GE|Georgia|GEL
DE|Germany|EUR
GH|Ghana|GHS
GR|Greece|EUR
GT|Guatemala|GTQ
GN|Guinea|GNF
GY|Guyana|GYD
HN|Honduras|HNL
HK|Hong Kong|HKD
HU|Hungary|HUF
IS|Iceland|ISK
ID|Indonesia|IDR
IR|Iran|IRR
IQ|Iraq|IQD
IE|Ireland|EUR
IL|Israel|ILS
IT|Italy|EUR
JM|Jamaica|JMD
JP|Japan|JPY
JO|Jordan|JOD
KZ|Kazakhstan|KZT
KE|Kenya|KES
KW|Kuwait|KWD
KG|Kyrgyzstan|KGS
LA|Laos|LAK
LV|Latvia|EUR
LB|Lebanon|LBP
LY|Libya|LYD
LT|Lithuania|EUR
LU|Luxembourg|EUR
MG|Madagascar|MGA
MW|Malawi|MWK
MY|Malaysia|MYR
MV|Maldives|MVR
ML|Mali|XOF
MT|Malta|EUR
MU|Mauritius|MUR
MX|Mexico|MXN
MD|Moldova|MDL
MN|Mongolia|MNT
ME|Montenegro|EUR
MA|Morocco|MAD
MZ|Mozambique|MZN
MM|Myanmar|MMK
NA|Namibia|NAD
NP|Nepal|NPR
NL|Netherlands|EUR
NZ|New Zealand|NZD
NI|Nicaragua|NIO
NE|Niger|XOF
NG|Nigeria|NGN
MK|North Macedonia|MKD
NO|Norway|NOK
OM|Oman|OMR
PK|Pakistan|PKR
PA|Panama|PAB
PG|Papua New Guinea|PGK
PY|Paraguay|PYG
PE|Peru|PEN
PH|Philippines|PHP
PL|Poland|PLN
PT|Portugal|EUR
QA|Qatar|QAR
RO|Romania|RON
RU|Russia|RUB
RW|Rwanda|RWF
SA|Saudi Arabia|SAR
SN|Senegal|XOF
RS|Serbia|RSD
SC|Seychelles|SCR
SL|Sierra Leone|SLE
SG|Singapore|SGD
SK|Slovakia|EUR
SI|Slovenia|EUR
SO|Somalia|SOS
ZA|South Africa|ZAR
KR|South Korea|KRW
SS|South Sudan|SSP
ES|Spain|EUR
LK|Sri Lanka|LKR
SD|Sudan|SDG
SR|Suriname|SRD
SE|Sweden|SEK
CH|Switzerland|CHF
SY|Syria|SYP
TW|Taiwan|TWD
TJ|Tajikistan|TJS
TZ|Tanzania|TZS
TH|Thailand|THB
TG|Togo|XOF
TT|Trinidad and Tobago|TTD
TN|Tunisia|TND
TR|Türkiye|TRY
TM|Turkmenistan|TMT
UG|Uganda|UGX
UA|Ukraine|UAH
AE|United Arab Emirates|AED
GB|United Kingdom|GBP
US|United States|USD
UY|Uruguay|UYU
UZ|Uzbekistan|UZS
VE|Venezuela|VES
VN|Vietnam|VND
YE|Yemen|YER
ZM|Zambia|ZMW
ZW|Zimbabwe|ZWG
`;

export const COUNTRIES: Country[] = TABLE.trim().split('\n').map((line) => {
  const [code, name, currency] = line.split('|');
  return { code, name, currency };
});

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export const countryName = (code: string | null | undefined) => (code ? BY_CODE.get(code)?.name ?? code : '');
export const countryCurrency = (code: string | null | undefined) => (code ? BY_CODE.get(code)?.currency ?? 'USD' : 'USD');

/** The currencies offered, the commonest first. */
export const CURRENCIES = [...new Set(['USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CNY', 'SAR', ...COUNTRIES.map((c) => c.currency)])];

export const countryOptions = () => COUNTRIES.map((c) => ({ value: c.code, label: c.name, sublabel: c.currency }));
export const currencyOptions = () => [{ value: 'INR', label: 'INR', sublabel: 'Indian rupee' }, ...CURRENCIES.map((c) => ({ value: c, label: c }))];
