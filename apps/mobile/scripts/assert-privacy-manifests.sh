#!/usr/bin/env bash
# Privacy manifests must be strict XML, not just parseable plists.
#
# `plutil -lint` passes a file that a strict XML parser rejects, because
# CoreFoundation's parser is lenient. Apple's upload validator is not:
# a `--` inside an XML comment is illegal XML, and it came back as
#
#   ITMS-91056: Invalid privacy manifest - The PrivacyInfo.xcprivacy
#   file from the following path is invalid
#
# which names the file but not the line, the character, or the fact that
# the problem is in a comment rather than in the keys and values the
# message talks about. Build 0.2.18 was rejected for exactly this after
# passing every local check. xmllint catches it in a second.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
for f in ios/privacy/*/PrivacyInfo.xcprivacy; do
  if ! out=$(xmllint --noout "$f" 2>&1); then
    echo "invalid XML: $f" >&2
    echo "$out" >&2
    status=1
  fi
done

# Apple publishes a closed set of purposes. `...PurposeCustomerSupport`
# reads perfectly and does not exist -- App Store Connect's own form
# offers no such choice, which is how it was spotted. A purpose outside
# this list is silently wrong until an upload is rejected.
valid='ThirdPartyAdvertising|DeveloperAdvertising|Analytics|ProductPersonalization|AppFunctionality|Other'
while read -r purpose; do
  case "$purpose" in
    NSPrivacyCollectedDataTypePurposes) continue ;;
  esac
  name=${purpose#NSPrivacyCollectedDataTypePurpose}
  if ! printf '%s' "$name" | grep -qE "^($valid)$"; then
    echo "not a valid collected-data purpose: $purpose" >&2
    status=1
  fi
done < <(grep -ho 'NSPrivacyCollectedDataTypePurpose[A-Za-z]*' ios/privacy/*/PrivacyInfo.xcprivacy | sort -u)

[ $status -eq 0 ] && echo "privacy manifests OK"
exit $status
