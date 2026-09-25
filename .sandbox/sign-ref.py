import base64
import hashlib
import hmac
import time
from urllib.parse import quote_plus

# The reference implementation, verbatim from the published DingTalk robot
# tutorial (cloud.tencent.com.cn/developer/article/2225115). If notify-relay's
# Node sign does not match this byte for byte, every DingTalk delivery fails.
def creat_sign(secret):
    timestamp = str(round(time.time() * 1000))
    se = secret.encode('utf-8')
    tse = '{}\n{}'.format(timestamp, secret)
    tsee = tse.encode('utf-8')
    hmac_code = hmac.new(se, tsee, digestmod=hashlib.sha256).digest()
    sign = quote_plus(base64.b64encode(hmac_code))
    return timestamp, sign

secret = 'SECabc123XYZ'
timestamp = '1700000000000'
se = secret.encode('utf-8')
tse = '{}\n{}'.format(timestamp, secret)
hmac_code = hmac.new(se, tse.encode('utf-8'), digestmod=hashlib.sha256).digest()
sign = quote_plus(base64.b64encode(hmac_code))

print('PYTHON stringToSign = ' + repr(tse))
print('PYTHON raw base64   = ' + base64.b64encode(hmac_code).decode())
print('PYTHON sign         = ' + sign)
