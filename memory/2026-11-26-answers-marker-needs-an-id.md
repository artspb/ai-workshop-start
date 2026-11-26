# A round answering no review body ends with `<!-- address-review -->`, never an empty `answers:`
`<!-- address-review answers: -->` does not match the marker pattern (`answers:[0-9,]+`), so the round's own review
reads as a body that is not yours, with findings, and starts another run. With no body to answer, use the plain marker.
**When**: address-review section 3, the submit of a round whose only answers are thread replies
**Evidence**: pull request #69, review 6078199851: submitted with the empty list, then fixed with `updatePullRequestReview`
