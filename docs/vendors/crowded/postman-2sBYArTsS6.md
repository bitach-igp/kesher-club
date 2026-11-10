# Crowded API Docs
Welcome to the Crowded API documentation! Crowded is a comprehensive financial management platform that empowers organizations to streamline their financial operations with banking, payment processing, spending and compliance services.

This API provides access to core Crowded services for the purpose of integrating powerful financial management capabilities directly into external applications. Whether you're building internal tools, customer-facing applications, or automated workflows, Crowded's API provides the flexibility to customize business financial operations.

Quick definitions

Our API is organized into several service areas, designed to handle specific aspects of the Crowded platform:

Here's a diagram to help make sense of hierarchy of Crowded:



Organization

Organizations, and their corresponding IDs, are required. Every chapter, user, account, is associated under an organization.

Chapters

Chapters are the core of Crowded, which houses the other actions of the platform (i.e. accounts are always associated with a chapter). Multiple chapters may be associated one organization, but not necessarily.

Applications

Manage and create applications to open a bank account with a financial institution.


Process and track bank account applications



Manage application workflows and approval processes



Secure handling of sensitive documents and identity verification



Monitor application status and history




Accounts

Primary Checking Account: A full-service bank account, with a unique account number and a routing number, maintained by a financial institution, in which a customer can deposit and withdraw money.

Available services

Chapters


Create Chapter(s)



Get and get all Chapters



Patch Chapter



Archive Chapters




Contacts


Create Contacts in bulk



Retrieve Contact information



Patch Contacts



Archive Contacts




Applications


Create and submit bank account applications



Get the application form URL



Get or Get all applications




Accounts


Get and get all accounts


Things to Note

Authentication

All endpoints require authentication via Bearer token.




Header
Value
Required





Authorization
Bearer
Yes






Pagination

All list endpoints support pagination using the following query parameters:

Query Parameters




Parameter
Type
Default
Description





pagination[limit]
number
10
Records per page (1-100)



pagination[offset]
number
0
Records to skip



pagination[page]
number
1
Page number (alternative to offset)





Note: If both offset and page are provided, offset takes precedence.

Response Meta

All paginated responses include a meta.pagination object:




Field
Type
Description





meta.pagination.total
number
Total number of records



meta.pagination.limit
number
Records per page



meta.pagination.offset
number
Records skipped



meta.pagination.sort
string
Sort field applied



meta.pagination.order
string
Sort direction (asc or desc)






Sorting

List endpoints support sorting via query parameters:




Parameter
Type
Default
Description





sort[field]
string
createdAt
Field to sort by (varies by endpoint)



sort[direction]
string
DESC
Sort direction: ASC or DESC






Request Body Format

All POST/PATCH requests use a wrapped format:

{
  "data": {
    // request fields here
  }
}



Response Format

Single Item

{
  "data": {
    // response fields here
  }
}


Paginated List

{
  "data": [
    // array of items
  ],
  "meta": {
    "pagination": {
      "total": 100,
      "limit": 10,
      "offset": 0,
      "sort": "createdAt",
      "order": "desc"
    }
  }
}



Common Error Responses




Status
Description





400
Bad Request - Validation error in request body or query parameters



401
Unauthorized - Missing, invalid, or expired token



403
Forbidden - User lacks permission (wrong role or no access to resource)



404
Not Found - Resource does not exist






Data Types

Amounts

All monetary amounts are in cents (integer). Example: $100.00 = 10000

Dates

All timestamps are in ISO 8601 format. Example: 2024-01-15T10:30:00.000Z

Phone Numbers

Phone numbers use E.164 format. Example: +15551234567

Environments


Sandbox: Use for development and testing with simulated data



Production: Live environment with real financial transactions




Rate Limiting


Our rate limit is based on your API key and is set to 1000 requests per minute



Bulk operations are limited to 100 items in each request



Contact support for rate limit increases




Support

For technical support or API access requests, contact support@bankingcrowded.com

## Organizations
Organizations are top-level entities in the Crowded platform hierarchy. They serve as containers for chapters and must be created before chapters can be added.

Hierarchy

Organization
└── Chapter(s)
    ├── Contacts
    ├── Accounts
    └── Collections
        └── Intents

Key Concepts

Organization

An organization represents a parent entity that groups related chapters together.


Acts as the top-level container in the hierarchy

Can contain multiple chapters

Provides organizational structure for multi-chapter setups

Examples: "National Headquarters", "Regional Division", "Parent Organization"


Onboarding Links

Partners can mint a single-use onboarding link that invites someone to self-onboard a brand-new organization. The organization created through the link is automatically attributed to the partner.


Single-use and time-limited

The invited user completes signup and names the organization

Reconcile the new organization with the link via the partnerInvitationId field on the organization-created webhook (equal to the link's linkId)

### Create Organization — POST https://sandbox-api.crowdedfinance.com/api/v1/organizations
Creates a new organization that will be associated with the partner. Organizations serve as containers for chapters.

Request Fields




Field
Type
Required
Description





name
string
Yes
Organization name (max 255 characters)





Response Fields




Field
Type
Description





id
string
Organization UUID



name
string
Organization name



createdAt
string
ISO 8601 timestamp
REQUEST BODY: {
    "data": {
        "name": "Crowded Technologies Inc."
    }
}
RESPONSE 201 Create Organization: {
    "data": {
        "id": "organization_id",
        "name": "Crowded Technologies Inc.",
        "createdAt": "2025-01-01T00:00:00Z"
    }
}

### Get all — GET https://sandbox-api.crowdedfinance.com/api/v1/organizations
Returns all organizations created by or associated with the user. Organizations are top-level entities that contain chapters.

Query Parameters




Parameter
Type
Description





search
string
Search by organization name (case-insensitive partial match)



sort[field]
string
Sort by: name, createdAt





Response Fields




Field
Type
Description





id
string
Organization UUID



name
string
Organization name



createdAt
string
ISO 8601 timestamp
RESPONSE 200 Get all: {
    "data": [
        {
            "id": "organization_id",
            "name": "Crowded Technologies Inc.",
            "createdAt": "2025-01-01T00:00:00Z"
        }
    ],
    "meta": {
        "pagination": {
            "total": 1,
            "limit": 10,
            "offset": 0,
            "sort": "createdAt",
            "order": "desc"
        }
    }
}

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/organizations/:organizationId
Returns detailed information about a single organization. Only returns organizations that belong to the authenticated user.

Response Fields




Field
Type
Description





id
string
Organization UUID



name
string
Organization name



createdAt
string
ISO 8601 timestamp
RESPONSE 200 Get: {
    "data": {
        "id": "organization_id",
        "name": "Crowded Technologies Inc.",
        "createdAt": "2025-01-01T00:00:00Z"
    }
}

### Create Onboarding Link — POST https://sandbox-api.crowdedfinance.com/api/v1/organizations/onboarding-links
Creates a single-use onboarding link that invites someone to set up a new organization linked to your partner account. Share the returned shortUrl with the invited user; when they complete signup, a new organization is created and automatically attributed to your partner account.

Reconcile the resulting organization by matching linkId against the partnerInvitationId on the platform.organization.created webhook.

Request Fields




Field
Type
Required
Description





theme
string
No
Whitelabel theme UUID applied to the onboarding experience





Response Fields




Field
Type
Description





linkId
string
Onboarding link identifier (matches partnerInvitationId on the organization-created webhook)



url
string
Full (unshortened) onboarding URL carrying the invite token



shortUrl
string
Shortened single-use onboarding URL to share with the invited user



expiration
string
ISO 8601 timestamp when the link expires
REQUEST BODY: {
    "data": {
        "theme": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    }
}
RESPONSE 201 Create Onboarding Link: {
    "data": {
        "linkId": "550e8400-e29b-41d4-a716-446655440000",
        "url": "https://app.crowded.me/signup?token=abc123&theme=7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "shortUrl": "https://app.crowded.me/onboard?token=abc123",
        "expiration": "2026-06-16T00:00:00.000Z"
    }
}

## Chapters
Chapters are the core operational units in Crowded. They house contacts, accounts, and collections, serving as the primary entity where financial operations take place.

Hierarchy

Organization
└── Chapter
    ├── Contacts (members)
    ├── Accounts (bank accounts)
    └── Collections (payment requests)
        └── Intents (payment assignments)


Key Concepts

Chapter

A chapter represents an operational unit within an organization.


Must belong to an organization (parent-child relationship)



Contains contacts who can be assigned to collections



Holds bank accounts for financial transactions



Manages collections for payment processing



Examples: "Local Chapter #123", "Downtown Branch", "Main Campus"




Account Owner (Admin)

When creating a chapter, you can optionally specify an account owner:


The account owner becomes the primary admin for the chapter



Has administrative permissions for chapter management



Receives notifications and can manage financial operations




Business Verticals

Chapters are categorized by business vertical.




Value
Category





SororitiesFraternities
Religious, Civic & Social



Camp
Religious, Civic & Social



Scouts
Religious, Civic & Social



GradeSchoolGroup
Religious, Civic & Social



SocialClub
Religious, Civic & Social



SportsClub
Religious, Civic & Social



CollegeGroup
Religious, Civic & Social



ReligiousCivicAndSocialOrganizations
Religious, Civic & Social



EducationalServices
Educational



ArtsEntertainmentAndRecreation
Arts & Recreation



HealthCareAndSocialAssistance
Healthcare



AgricultureForestryFishingOrHunting
Agriculture



FinancialServicesOther
Financial Services



PersonalCareServices
Personal Care



PublicAdministration
Public Admin



RealEstate
Real Estate



TechnologyMediaOrTelecom
Technology





Chapter Status




Status
Description





Active
Chapter is operational



Archived
Chapter has been deactivated

### Create Chapter — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters
Creates a new chapter linked to an existing organization. Optionally creates an owner (admin) user for the chapter.

Request Fields




Field
Type
Required
Description





name
string
Yes
Chapter name (max 255 characters)



organizationId
string
Yes
Parent organization UUID



businessVertical
string
Yes
Business vertical (see values below)



owner
object
No
Owner/admin details





Owner Object




Field
Type
Required
Description





firstName
string
Yes
First name (max 255 chars)



lastName
string
Yes
Last name (max 255 chars)



mobile
string
Yes
Phone in E.164 format



email
string
Yes
Email address



dateOfBirth
string
No
YYYY-MM-DD format





Business Verticals




Value
Category





SororitiesFraternities
Religious, Civic & Social



Camp
Religious, Civic & Social



Scouts
Religious, Civic & Social



GradeSchoolGroup
Religious, Civic & Social



SocialClub
Religious, Civic & Social



SportsClub
Religious, Civic & Social



CollegeGroup
Religious, Civic & Social



ReligiousCivicAndSocialOrganizations
Religious, Civic & Social



EducationalServices
Educational



ArtsEntertainmentAndRecreation
Arts & Recreation



HealthCareAndSocialAssistance
Healthcare



AgricultureForestryFishingOrHunting
Agriculture



FinancialServicesOther
Financial Services



PersonalCareServices
Personal Care



PublicAdministration
Public Admin



RealEstate
Real Estate



TechnologyMediaOrTelecom
Technology





Response Fields




Field
Type
Description





id
string
Chapter UUID



name
string
Chapter name



organization
string
Parent organization name



organizationId
string
Parent organization UUID



status
string
Active



businessVertical
string
Business vertical category



ein
string
null



createdAt
string
ISO 8601 timestamp



contactId
string
Contact UUID of the created owner. Only present when owner was provided.
REQUEST BODY: {
    "data": {
        "name": "Headquarters",
        "businessVertical": "ReligiousCivicAndSocialOrganizations",
        "organizationId": "organization_id",
        "owner": {
            "firstName": "John",
            "lastName": "Claude",
            "mobile": "+12345678901",
            "email": "john@example.com",
            "dateOfBirth": "1980-01-01"
        }
    }
}
RESPONSE 201 Create Chapter: {
    "data": {
        "id": "chapter_id",
        "name": "Headquarters",
        "organization": "Crowded Technologies Inc",
        "organizationId": "organization_id",
        "status": "Active",
        "businessVertical": "ReligiousCivicAndSocialOrganizations",
        "ein": null,
        "createdAt": "2025-01-01T00:00:00Z",
        "contactId": "contact_id"
    }
}

### Get all — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters?pagination[limit]=10&pagination[page]=1
Returns all chapters associated across all organizations. Chapters are the primary organizational units where contacts, collections, and accounts are managed.

Query Parameters




Parameter
Type
Description





search
string
Search by chapter name (case-insensitive partial match)



sort[field]
string
Sort by: name, createdAt



filter[organizationId]
string
Filter chapters to a single organization by its UUID (within the partner's scope)



filter[isMasterSubAccount]
boolean
Filter to chapters that are (true) or are not (false) a master chapter that manages same-EIN sub-accounts



filter[isMasterSubEntity]
boolean
Filter to chapters that are (true) or are not (false) a master chapter that manages different-EIN sub-entities (separate organizations with their own EIN)



include[]
string[]
Optional extra data to populate per chapter. Supported value: collectBalance. Repeat the parameter for multiple values (include[]=collectBalance); comma-separated values are not supported. Opt-in because it adds latency.





Example: GET /api/v1/chapters?include[]=collectBalance&pagination[limit]=25

Response Fields




Field
Type
Description





id
string
Chapter UUID



name
string
Chapter name



organization
string
Parent organization name



organizationId
string
Parent organization UUID



status
string
Active or Archived



businessVertical
string
Business vertical category



ein
string
null



masterChapterId
string
undefined



isMasterSubAccount
boolean
true when this chapter is a master chapter that manages same-EIN sub-accounts (chapters sharing this chapter's EIN)



isMasterSubEntity
boolean
true when this chapter is a master chapter that manages different-EIN sub-entities (separate organizations with their own EIN)



createdAt
string
ISO 8601 timestamp



collectBalance
number
undefined



collectCaptured
number
Funds collected and captured, but not yet in transit to the chapter, in cents. Always returned (default 0), including before banking is enabled.



collectInTransit
number
Collected funds currently in transit to the chapter and not yet available, in cents. Always returned (default 0), including before banking is enabled.






collectCaptured and collectInTransit are computed for the whole page in a single lookup. Funds move into the chapter's available collect balance as each payment settles; settlement runs continuously in batches. 



collectBalance is opt-in: it is populated only when you pass include[]=collectBalance. It is omitted from the default response (so the list stays fast) and omitted for a chapter when its balance cannot be determined — treat a missing collectBalance as "not available right now", not as 0.
RESPONSE 200 Get all: {
    "data": [
        {
            "id": "chapter_id",
            "name": "Headquarters",
            "organization": "Crowded Technologies Inc",
            "organizationId": "organization_id",
            "status": "Active",
            "businessVertical": "ReligiousCivicAndSocialOrganizations",
            "ein": "123456789",
            "createdAt": "2025-01-01T00:00:00Z",
            "collectCaptured": 4000,
            "collectInTransit": 18000
        }
    ],
    "meta": {
        "pagination": {
            "total": 1,
            "limit": 10,
            "offset": 0,
            "sort": "createdAt",
            "order": "desc"
        }
    }
}

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId
Returns detailed information about a single chapter. Only returns chapters that belong to the authenticated user.

Response Fields




Field
Type
Description





id
string
Chapter UUID



name
string
Chapter name



organization
string
Parent organization name



organizationId
string
Parent organization UUID



status
string
Active or Archived



businessVertical
string
Business vertical category



ein
string | null
Employer Identification Number



masterChapterId
string | undefined
UUID of the master chapter (present only for sub-account chapters that share their master chapter's EIN)



isMasterSubAccount
boolean
true when this chapter is a master chapter that manages same-EIN sub-accounts (chapters sharing this chapter's EIN)



isMasterSubEntity
boolean
true when this chapter is a master chapter that manages different-EIN sub-entities (separate organizations with their own EIN)



createdAt
string
ISO 8601 timestamp



collectBalance
number | undefined
Funds currently available in the chapter's collect account, in cents. Returned only when the chapter has banking enabled.



collectCaptured
number
Funds collected and captured, but not yet in transit to the chapter, in cents. Always returned (default 0), including before banking is enabled.



collectInTransit
number
Collected funds currently in transit to the chapter and not yet available, in cents. Always returned (default 0), including before banking is enabled.






collectCaptured and collectInTransit reflect funds collected on the chapter's behalf that have not yet reached its collect account. They are always returned — even before the chapter has banking enabled — so funds remain visible while in transit. Funds move into collectBalance as each payment settles; settlement runs continuously in batches, so an active chapter routinely shows small captured/in-transit amounts alongside an available balance. For chapters that have not completed banking setup, collected funds remain in transit until setup is complete and settlement runs. Values reflect payment-processing state and may briefly overlap collectBalance while a settlement is being recorded.
RESPONSE 200 Get: {
    "data": {
        "id": "chapter_id",
        "name": "Headquarters",
        "organization": "Crowded Technologies Inc",
        "organizationId": "organization_id",
        "status": "Active",
        "businessVertical": "ReligiousCivicAndSocialOrganizations",
        "ein": "123456789",
        "createdAt": "2025-01-01T00:00:00Z",
        "collectBalance": 150000,
        "collectCaptured": 4000,
        "collectInTransit": 18000
    }
}

### Archive Chapter — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:id/archive
REQUEST BODY: {
    "reason": "ByCustomer"
}
RESPONSE 202 Archive Chapter: {
    "data": {
        "id": "chapter_id",
        "name": "Headquarters",
        "organization": "Crowded Technologies Inc",
        "organizationId": "organization_id",
        "status": "Archived",
        "businessVertical": "ReligiousCivicAndSocialOrganizations",
        "ein": "123456789",
        "createdAt": "2025-01-01T00:00:00Z"
    }
}

### Create Onboarding Link — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/onboarding-links
Creates a single-use onboarding link that invites someone to set up a new child chapter inside an existing chapter's organization. When the invited user completes signup, a new chapter is created in the same organization as the parent chapter (:chapterId) and attributed to your partner account through it.

Use this when a child chapter needs its own KYB — for example, it does not share the parent organization's EIN — and therefore needs its own onboarding. The parent chapter must already be an onboarded chapter in your partner account that is eligible to add child chapters.

This endpoint has two modes:


Link mode (default): omit email. The response includes url and shortUrl — share the shortUrl with the invited user yourself.

Email mode: provide email. Crowded emails the onboarding invitation to that address directly, and the response returns only linkId and expiration (no url/shortUrl).


Reconcile the resulting chapter by matching linkId against the partnerInvitationId on the platform.chapter.created webhook.

Path Parameters




Parameter
Type
Description





chapterId
string
UID of the parent chapter the new child chapter will be created under





Request Fields

All fields are optional.




Field
Type
Required
Description





theme
string
No
Whitelabel theme UUID applied to the onboarding experience



email
string
No
Recipient email. When provided (email mode), Crowded emails the onboarding invitation to this address directly.



firstName
string
No
Recipient first name, used in the invitation email greeting. Only allowed together with email.



lastName
string
No
Recipient last name. Only allowed together with email.





Providing firstName or lastName without an email is rejected with 400.

Response Fields




Field
Type
Description





linkId
string
Onboarding link identifier (matches partnerInvitationId on the chapter-created webhook)



url
string
Full (unshortened) onboarding URL carrying the invite token. Link mode only — omitted in email mode.



shortUrl
string
Shortened single-use onboarding URL to share with the invited user. Link mode only — omitted in email mode.



expiration
string
ISO 8601 timestamp when the invitation expires





Example — email mode

Request:

{
    "data": {
        "email": "treasurer@example.org",
        "firstName": "Jane"
    }
}


Response (the onboarding link is emailed to the recipient):

{
    "data": {
        "linkId": "550e8400-e29b-41d4-a716-446655440000",
        "expiration": "2026-06-16T00:00:00.000Z"
    }
}
REQUEST BODY: {
    "data": {
        "theme": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    }
}
RESPONSE 201 Link mode: {
    "data": {
        "linkId": "550e8400-e29b-41d4-a716-446655440000",
        "url": "https://app.crowded.me/signup?token=abc123&theme=7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "shortUrl": "https://app.crowded.me/onboard?token=abc123",
        "expiration": "2026-06-16T00:00:00.000Z"
    }
}
RESPONSE 201 Email mode: {
    "data": {
        "linkId": "550e8400-e29b-41d4-a716-446655440000",
        "expiration": "2026-06-16T00:00:00.000Z"
    }
}

## Application
The application API allows for the submission of bank account applications on behalf of chapters. This initiates the process for a chapter to receive banking capabilities (FDIC insurance, money movement tools, etc.).

Flow


Partner submits bank application with chapter and primary officer details (name, address, EIN, etc.)

Bank application is submitted for review

Chapter receives banking capabilities upon approval


As an alternative to submitting all fields directly, partners can use the hosted Application Form flow (see the Application Form folder): the partner creates (or resumes) a hosted form, the chapter's account owner completes it through a secure URL, and an application is created on submission. While a hosted form is in progress, direct submission via POST /applications returns 409.

Application Status




Status
Description





Pending
Initial status — the application has been submitted and is awaiting a decision



PendingReview
The application is undergoing additional review; this is a transient status and requires no action



AwaitingDocuments
Additional documents required



Approved
Application approved, banking enabled



Denied
Application rejected



Canceled
Application canceled by user



FormInProgress
No application submitted yet, but a hosted application form is in progress (see formStatus below)





Form Status

When status is FormInProgress, the GET /applications response includes a formStatus field describing the hosted Application Form state:




formStatus
Description





EnterBusinessInformation
A form is in progress and can be resumed (a formUrl resume link is provided)



InProgressByAnotherUser
A different contact already started the form





When neither an application nor a hosted form exists for the chapter, GET /applications returns 400 with There is no application for this chapter.

Prerequisites


Chapter must exist and be accessible to the partner

Required fields: ein, stateOfIncorporation, yearOfIncorporation

### Application Form
Hosted bank application form for chapter banking setup.

The Application Form API lets a chapter's account owner complete their bank application through a hosted application form instead of submitting all fields directly. The form collects the organization and officer details required for banking, captures end-user consent, and returns a secure URL the end user can open to finish the application.

This is an alternative to submitting the application directly via POST /applications.

Acting contact


The acting contact must be the chapter account owner; otherwise the request is rejected with 403

The acting contact is selected with the X-Impersonate-User-Uid header or contactId body field (defaults to the chapter account owner)


Form status values




Status
Description





EnterBusinessInformation
A form is in progress for the acting contact and can be resumed — url is present



PendingCreation
No form has been created yet for the chapter — url is null



InProgressByAnotherUser
A different contact already started the form — url is null



ApplicationExists
An application has already been submitted for the chapter. url remains available as the document-upload surface while the application is pending or awaiting documents, and becomes null once it is approved or denied





Form lifetime


Hosted application forms do not expire — an in-progress form stays open until it is completed

While a form is in progress, direct submission via POST /applications is rejected with 409

To unblock a chapter, complete the in-progress form using its resume url (re-fetch it any time with GET /applications/form or via the formUrl field on GET /applications)

#### Get Application Form Status — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/applications/form
Returns the status of the hosted bank application form for the chapter and, when a form is in progress for the acting contact, the URL to resume it. Use this endpoint to check whether a form has been started and whether it can be resumed before calling POST /applications/form. No side effects.

The acting contact is selected with the X-Impersonate-User-Uid header (defaults to the chapter account owner) and must be the chapter account owner (403 otherwise).

Path Parameters




Parameter
Type
Required
Description





chapterId
string (UUID)
Yes
Chapter identifier





Request Headers




Header
Value
Required





X-Impersonate-User-Uid
Contact UUID to act as
No (defaults to chapter account owner)





Response Fields




Field
Type
Description





status
string
Current form status. One of: EnterBusinessInformation, PendingCreation, InProgressByAnotherUser, ApplicationExists



url
string | null
Hosted form link. Present when status is EnterBusinessInformation (resume link), and when status is ApplicationExists while the application is still pending or awaiting documents (the hosted form is also the document-upload surface); null otherwise





Status Values




Status
url
Meaning





EnterBusinessInformation
present
A form is in progress for the acting contact and can be resumed



PendingCreation
null
No form has been created yet for the chapter



InProgressByAnotherUser
null
A different contact already started the form



ApplicationExists
present until approved/denied
An application has already been submitted for the chapter. The link remains available as the document-upload surface while the application is pending or awaiting documents, and becomes null once it is approved or denied





Example Response

{
  "data": {
    "status": "EnterBusinessInformation",
    "url": "https://forms.example.com/applications/abc123"
  }
}



Error Responses




Error
HTTP Status
Description





Forbidden
403
Acting contact is not the chapter account owner, or chapter is not owned by the partner



Unauthorized
401
Missing, invalid, or expired token





Notes


The acting contact must be the chapter account owner; any other contact receives 403

A form is tied to the contact who started it — when another contact started it, this endpoint reports InProgressByAnotherUser with a null url

This is a read-only check; use POST /applications/form to create or resume the form
RESPONSE 200 Form In Progress: {
    "data": {
        "status": "EnterBusinessInformation",
        "url": "https://forms.example.com/application-form/abc123"
    }
}
RESPONSE 200 No Form Created Yet: {
    "data": {
        "status": "PendingCreation",
        "url": null
    }
}

#### Create Application Form — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/applications/form
Records bank-application consent for the acting contact, then creates (or resumes) the hosted application form and returns its URL.

Idempotent: if a form is already in progress for the acting contact, the existing form is returned.

Note: Request body must be wrapped in data object. Response is also wrapped in data object.

Path Parameters




Parameter
Type
Required
Description





chapterId
string (UUID)
Yes
Chapter Identifier





Request Fields




Field
Type
Required
Description





contactIp
string
Yes
End user IP address from browser (must be the actual user IP, not the partner server IP) — used to record consent



contactId
string (UUID)
No
Contact to act as — takes priority over the X-Impersonate-User-Uid header. The contact must be the chapter account owner





Response Fields




Field
Type
Description





status
string
Form state: EnterBusinessInformation, PendingCreation, InProgressByAnotherUser, or ApplicationExists



url
string | null
Hosted form URL to complete or resume the form





Error Responses




Error
Description





ValidationError
400 — Missing or malformed contactIp / request body



Forbidden
403 — Acting contact is not the chapter account owner, or chapter is not owned by the partner





Notes


Consent is automatically recorded before the form is created

Hosted forms do not expire; resume an in-progress form via the returned url
REQUEST BODY: {
    "data": {
        "contactIp": "203.0.113.10",
        "contactId": "550e8400-e29b-41d4-a716-446655440000"
    }
}
RESPONSE 201 Form Created: {
    "data": {
        "status": "EnterBusinessInformation",
        "url": "https://forms.example.com/application-form/abc123"
    }
}
RESPONSE 403 Not Account Owner: {
    "type": "ForbiddenError",
    "statusCode": 403,
    "message": "The acting contact must have one of the following roles: Account Owner",
    "requestId": "req_abc123"
}

### Submit Bank Application — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/applications
Submits a bank application with consent handling. The system:


Records user consent with the provided IP address



Submits the application for review




Note: Request body must be wrapped in data object. Response is also wrapped in data object.

Path Parameters




Parameter
Type
Required
Description





chapterId
string (UUID)
Yes
Chapter identifier





Request Fields

Organization Details




Field
Type
Required
Description





organizationName
string
Yes
Legal organization name (max 255 characters)



ein
string
Yes
Employer Identification Number (9 digits, no dashes)



stateOfIncorporation
string
Yes
US state code (2 letters, e.g., CA, NY)



yearOfIncorporation
string
Yes
4-digit year (cannot be future)



website
string
Yes
Organization website URL



address
object
Yes
Organization address



phone
object
Yes
Organization phone





Officer Details




Field
Type
Required
Description





officer.fullName
object
Yes
Officer's full name



officer.fullName.first
string
Yes
First name



officer.fullName.last
string
Yes
Last name



officer.address
object
Yes
Officer's address



officer.ssn
string
Yes
Social Security Number (9 digits, no dashes)



officer.title
string
No
Officer title (e.g., President, Treasurer, CEO)





Address Object




Field
Type
Required
Description





street
string
Yes
Street address



street2
string
No
Secondary address line



city
string
Yes
City



state
string
Yes
US state code (2 letters)



postalCode
string
Yes
ZIP code



country
string
Yes
Country code (2 letters, e.g., US)





Phone Object




Field
Type
Required
Description





countryCode
string
Yes
Country dialing code (e.g., 1)



number
string
Yes
Phone number (digits only)





Other Fields




Field
Type
Required
Description





idempotencyKey
string (UUID)
Yes
Unique key for request deduplication



contactIp
string
Yes
End user's IP address (IPv4 or IPv6)



contactId
string (UUID)
No
Contact UID for user impersonation. The contact must be the chapter account owner





Response Fields




Field
Type
Description





createdAt
string
ISO 8601 timestamp



status
string
Application status. One of: Pending, PendingReview, AwaitingDocuments, Approved, Denied, Canceled



additionalConsentUrl
string
null





Valid Officer Titles

CEO, COO, CFO, President, BenefitsAdministrationOfficer, CIO, VP, AVP, Treasurer, Secretary, Controller, Manager, Partner, Member

Valid US States

All 50 US states plus territories: AL, AK, AZ, AR, CA, CO, CT, DE, FL, GA, HI, ID, IL, IN, IA, KS, KY, LA, ME, MD, MA, MI, MN, MS, MO, MT, NE, NV, NH, NJ, NM, NY, NC, ND, OH, OK, OR, PA, RI, SC, SD, TN, TX, UT, VT, VA, WA, WV, WI, WY, AS, DC, FM, GU, MH, MP, PW, PR, VI

Example Request

{
  "data": {
    "organizationName": "ABC Nonprofit Inc",
    "officer": {
      "fullName": { "first": "John", "last": "Doe" },
      "address": {
        "street": "123 Main St",
        "city": "San Francisco",
        "state": "CA",
        "postalCode": "94102",
        "country": "US"
      },
      "ssn": "123456789",
      "title": "President"
    },
    "address": {
      "street": "456 Oak Ave",
      "city": "Los Angeles",
      "state": "CA",
      "postalCode": "90001",
      "country": "US"
    },
    "phone": { "countryCode": "1", "number": "5551234567" },
    "ein": "123456789",
    "stateOfIncorporation": "CA",
    "yearOfIncorporation": "2020",
    "website": "https://example.org",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "contactIp": "192.168.1.1"
  }
}



Example Response

{
  "data": {
    "createdAt": "2025-12-01T10:00:00.000Z",
    "status": "Pending",
    "additionalConsentUrl": null
  }
}



Error Responses




Error
Description





APPLICATION_EXIST
Chapter already has an application



ResourceConflictError
409 — An application form is already in progress for this chapter (started by any contact). Hosted forms do not expire; complete the form via its resume URL (see the Application Form folder)



EIN_DUPLICATE_BLOCKED
EIN is already registered in the system



NO_CONSENT
Consent was not recorded (internal error)



ForbiddenError
403 — Acting contact is not the chapter account owner
REQUEST BODY: {
    "data": {
        "chapterId": "chapter_id",
        "organizationName": "Acme Corporation",
        "officer": {
            "fullName": {
                "first": "John",
                "last": "Smith"
            },
            "address": {
                "street": "123 Main Street",
                "street2": "Suite 100",
                "city": "San Francisco",
                "state": "CA",
                "postalCode": "94102",
                "country": "US"
            },
            "phone": {
                "countryCode": "1",
                "number": "4155551234"
            },
            "title": "CEO",
            "dateOfBirth": "1985-03-15",
            "ssn": "000000009",
            "email": "john.smith@acmecorp.com"
        },
        "address": {
            "street": "456 Business Ave",
            "city": "Los Angeles",
            "state": "CA",
            "postalCode": "90001",
            "country": "US"
        },
        "phone": {
            "countryCode": "1",
            "number": "3105559876"
        },
        "ein": "123451349",
        "idempotencyKey": "ea3c7a8d-d48e-4d5c-836f-596597abf9b9",
        "stateOfIncorporation": "DE",
        "website": "https://www.acmecorp.com",
        "yearOfIncorporation": "2020",
        "contactIp": "135.72.197.64",
        "contactId": "contact_id"
    }
}
RESPONSE 409 Form Already In Progress: {
    "type": "ResourceConflictError",
    "statusCode": 409,
    "message": "An application form is already in progress for this chapter",
    "requestId": "req_abc123"
}

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/applications
Returns the current status and creation date of the bank application. Use this endpoint to check if an application exists and its current state.

When no application has been submitted yet but a hosted application form is in progress, the endpoint returns 200 with status = FormInProgress plus the additive formStatus and formUrl fields instead of an error. In that case createdAt is absent. When neither an application nor a form exists, the endpoint returns 400 with There is no application for this chapter (unchanged from before the hosted form flow). When an application exists, the response is unchanged (the form fields are absent).

When a submitted application is still being processed (Pending, PendingReview, or AwaitingDocuments), the response also includes formUrl — the hosted form doubles as the surface where the end user provides any additionally requested documents. formUrl is omitted once the application is approved or denied.

Path Parameters




Parameter
Type
Required
Description





chapterId
string (UUID)
Yes
Chapter identifier





Response Fields




Field
Type
Description





createdAt
string
ISO 8601 timestamp of application creation. Absent when status is FormInProgress (no application submitted yet)



status
string
Current application status. One of: Pending, PendingReview, AwaitingDocuments, Approved, Denied, Canceled, FormInProgress



additionalConsentUrl
string | null
URL for additional consent if required



formStatus
string (optional)
Present only when status is FormInProgress. One of: EnterBusinessInformation, InProgressByAnotherUser



formUrl
string | null (optional)
Present when status is FormInProgress (resume link for the hosted application form, or null when no resumable form exists) and while a submitted application is Pending, PendingReview, or AwaitingDocuments (the hosted form is also the document-upload surface). Absent once the application is approved or denied





Example Response

{
  "data": {
    "createdAt": "2025-12-01T10:00:00.000Z",
    "status": "Approved",
    "additionalConsentUrl": null
  }
}



Example Response (awaiting documents)

{
  "data": {
    "createdAt": "2025-12-01T10:00:00.000Z",
    "status": "AwaitingDocuments",
    "additionalConsentUrl": null,
    "formUrl": "https://forms.example.com/application-form/abc123"
  }
}



Example Response (form in progress)

{
  "data": {
    "status": "FormInProgress",
    "formStatus": "EnterBusinessInformation",
    "formUrl": "https://forms.example.com/application-form/abc123"
  }
}



Error Responses




Error
HTTP Status
Description





There is no application for this chapter
400
No application has been submitted and no hosted application form has been started for the chapter





Notes


Returns the latest status for submitted applications

Pending is the initial status set when an application is submitted; PendingReview indicates the application is undergoing additional review

FormInProgress indicates no application has been submitted yet but a hosted application form is in progress; inspect formStatus / formUrl (see the Application Form folder). Hosted forms do not expire — formUrl remains the way to resume and complete an in-progress form

While a submitted application is Pending, PendingReview, or AwaitingDocuments, formUrl points to the hosted form, which also serves as the document-upload surface for any additionally requested documents. It is omitted once the application is approved or denied

The There is no application for this chapter error (400) occurs when neither an application nor an in-progress hosted form exists for the chapter
RESPONSE 200 Form In Progress: {
    "data": {
        "status": "FormInProgress",
        "formStatus": "EnterBusinessInformation",
        "formUrl": "https://forms.example.com/application-form/abc123"
    }
}
RESPONSE 400 No Application: {
    "type": "ResourceInputError",
    "statusCode": 400,
    "message": "There is no application for this chapter",
    "requestId": "f4f9d3e0-1b2c-4d5e-8f9a-0b1c2d3e4f5a"
}

## Subaccounts
Subaccounts are chapters that share the same EIN as a parent chapter. They enable organizational hierarchies where a master chapter can manage multiple sub-chapters under a single tax entity.

Key Concepts


Parent Chapter: The master chapter that owns the subaccount



Same EIN: Subaccounts inherit the parent's EIN (tax ID)



Owner: Each subaccount requires a treasurer (owner) for account management



Bank Account: Subaccounts get their own deposit account under the parent chapter




Using Subaccount IDs

Once created, subaccounts function almost identically to regular chapters. The subaccount's id can be used as the chapterId parameter in most other endpoints:




Feature
Supported
Notes





Accounts
✅
Subaccounts have their own bank accounts



Contacts
✅
Manage contacts within the subaccount



Collections
✅
Create and manage collections and payment intents



Applications
❌
Subaccounts inherit the parent's bank setup





Tier Limits

Subaccount creation is subject to subscription tier limits. When the limit is reached, the API returns 429 Too Many Requests.

### Create Subaccounts — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/subaccounts
Creates a subaccount that shares the same EIN as the parent chapter. The subaccount gets its own bank deposit account and a treasurer (owner) user.

The owner can be provisioned in one of two mutually exclusive modes — provide exactly one of owner or email:


Owner mode (owner object): the owner is created directly as a treasurer user.

Email mode (email, with optional firstName/lastName): Crowded emails the owner a sub-account invitation and they self-onboard as treasurer. Use this when you don't have the owner's full details (mobile / date of birth) up front.


Owner provisioning is non-blocking - the subaccount is created successfully even if owner creation or invitation fails. Check owner.status in the response (Active / Invited / Failed).

Path Parameters




Parameter
Type
Description





chapterId
string
Parent chapter UUID





Request Fields




Field
Type
Required
Description





name
string
Yes
Subaccount name (max 255 characters)



idempotencyKey
string
Yes
UUID for idempotent requests



owner
object
Conditional
Owner/treasurer details (owner mode). Provide either owner or email, not both.



email
string
Conditional
Owner's email (email mode) — Crowded emails the owner an invitation. Provide either email or owner, not both.



firstName
string
No
Owner's first name (email mode only) — used in the invitation greeting. Not allowed without email.



lastName
string
No
Owner's last name (email mode only) — used in the invitation greeting. Not allowed without email.





Owner Object (owner mode)




Field
Type
Required
Description





firstName
string
Yes
First name (max 255 chars)



lastName
string
Yes
Last name (max 255 chars)



mobile
string
Yes
Phone in E.164 format (e.g., +12345678901)



email
string
Yes
Email address



dateOfBirth
string
No
YYYY-MM-DD format





Response Fields




Field
Type
Description





id
string
Subaccount UUID



name
string
Subaccount name



parentChapterId
string
Parent chapter UUID



status
string
Active or Archived



createdAt
string
ISO 8601 timestamp



owner
object
Owner details and status





Owner Response Object




Field
Type
Description





id
string
Owner UUID (empty in email mode until the owner onboards)



firstName
string
Owner's first name



lastName
string
Owner's last name



email
string
Owner's email



mobile
string
Owner's mobile (empty in email mode until the owner onboards)



status
string
Active (owner mode, created), Invited (email mode, invitation sent), or Failed



error
string
Error message (only if status is Failed)





Example Request — owner mode

{
  "data": {
    "name": "Youth Group",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "owner": {
      "firstName": "John",
      "lastName": "Doe",
      "mobile": "+12345678901",
      "email": "john.doe@example.com",
      "dateOfBirth": "1990-01-01"
    }
  }
}



Example Request — email mode (invite the owner)

{
  "data": {
    "name": "Youth Group",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "email": "john.doe@example.com",
    "firstName": "John",
    "lastName": "Doe"
  }
}



Example Response — owner mode

{
  "data": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "name": "Youth Group",
    "parentChapterId": "770e8400-e29b-41d4-a716-446655440002",
    "status": "Active",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "owner": {
      "id": "880e8400-e29b-41d4-a716-446655440003",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "mobile": "+12345678901",
      "status": "Active"
    }
  }
}



Example Response — email mode

{
  "data": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "name": "Youth Group",
    "parentChapterId": "770e8400-e29b-41d4-a716-446655440002",
    "status": "Active",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "owner": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "status": "Invited"
    }
  }
}



Error Responses




Status
Description





400
Invalid request (validation error — e.g. both owner and email, neither, or a name without email)



401
Unauthorized (invalid/missing token)



403
Forbidden (no access to parent chapter)



404
Parent chapter not found



429
Subscription quota exceeded (tier limit reached)





Business Logic


Tier Limits: Subject to SubAccountsCreate claim limit from subscription tier



Same EIN: Subaccount inherits parent chapter's EIN



Owner provisioning: Provide exactly one of owner or email.


Owner mode (owner): the owner is created directly as a treasurer with full account access (owner.status = Active).

Email mode (email): Crowded emails the owner a same-EIN sub-account invitation; they self-onboard as treasurer (owner.status = Invited). firstName/lastName are optional and used in the greeting; a name without an email is rejected.




Non-blocking Owner: Subaccount succeeds even if owner creation or invitation fails (owner.status = Failed)



Idempotency: Use idempotencyKey to safely retry failed requests



Interoperability: The returned id can be used as chapterId in other endpoints (accounts, contacts, collections, etc.) - see overview
REQUEST BODY: {
    "data": {
        "name": "Sponsored",
        "owner": {
            "firstName": "John",
            "lastName": "Claude",
            "mobile": "+12345678901",
            "email": "john@example.com",
            "dateOfBirth": "2000-01-01"
        },
        "idempotencyKey": "e18004c0-d077-462b-bb7c-1ce492ca8d4c"
    }
}

### Bulk fund subaccounts — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/subaccounts/fund
REQUEST BODY: {
    "data": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "amount": 2000,
        "description": "Monthly funding",
        "idempotencyKey": "b35f7496-04b4-4a26-8b35-8b4ad1a26478"
      }
    ]
  }

## Contacts
Contacts are individuals belonging to a chapter. They can be individuals who have paid collections, or uploaded to the platform.

Hierarchy

Chapter
└── Contact
    └── Intent (assigned to a collection)
        └── Payments


Key Concepts

Contact

A Contact represents an individual within a chapter.


Belongs to exactly one chapter



Can be assigned to multiple collections via intents



Identified by mobile phone number (unique within chapter)



Tracks payment history across all collections



Examples: members, donors, participants, students




Role Types




Role
Description





Admin
Treasurer with full chapter management permissions



Contact
Standard member with payment capabilities





Contact Status




Status
Description





Active
Contact is active and can be assigned to collections



Failed
Contact creation failed (check error field for details)



Archived
Contact has been soft-deleted





Bulk Creation

Contacts can be created in bulk with a single API call:


Each contact in the batch is processed independently



Failures don't prevent other contacts from being created



Response includes status for each contact



Duplicate mobile numbers will cause that entry to fail




Contact Matching

When creating intents, contacts are matched by mobile number:


If a contact with the mobile number exists, it's used



If no match is found, a new contact is created automatically



Mobile numbers must be in E.164 format (e.g., +15551234567)

### Bulk Create Contacts — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/contacts
Creates multiple contacts (members) in a single request. Each contact is validated individually, and the response includes the status of each creation attempt.

Request Fields

Array of contact objects:




Field
Type
Required
Description





firstName
string
Yes
First name



lastName
string
Yes
Last name



mobile
string
Yes
Phone in E.164 format



email
string
Yes
Email address



dateOfBirth
string
No
YYYY-MM-DD format



role
string
No
Admin or Contact. Default: Contact





Response Fields

Array of created contacts:




Field
Type
Description





id
string
Contact UUID



chapterId
string
Chapter UUID



firstName
string
First name



lastName
string
Last name



mobile
string
Phone (E.164 format)



email
string
Email address



dateOfBirth
string | null
Date of birth



status
string
Active or Failed



error
object | null
Error details if Failed



error.message
string
Error message



error.detail
object
Additional details



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp



archivedAt
string | null
Always null for new contacts





Business Logic


Contacts are matched by mobile number within the chapter

Duplicate mobile numbers will cause that entry to fail

Each contact in the batch is processed independently

Admin role allows full chapter management

Contact role allows basic payment capabilities
REQUEST BODY: {
    "data": [
        {
            "firstName": "John",
            "lastName": "Claude",
            "mobile": "+15675671234",
            "email": "john@example.com",
            "dateOfBirth": "1900-01-01"
        }
    ]
}
RESPONSE 201 Bulk Create Contacts: {
    "data": [
        {
            "id": "contact_id",
            "firstName": "John",
            "lastName": "Claude",
            "mobile": "+15675671234",
            "email": "john@example.com",
            "dateOfBirth": "1900-01-01",
            "chapterId": "chapter_id",
            "status": "Active",
            "createdAt": "2020-01-01T00:00:00Z",
            "updatedAt": "2020-01-01T00:00:00Z",
            "archivedAt": null
        }
    ]
}

### Get All — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/contacts
Returns all contacts belonging to a specific chapter. Contacts are individuals who can be assigned to collections for payment.

Query Parameters




Parameter
Type
Description





search
string
Search by firstName, lastName, email, or mobile (case-insensitive)



sort[field]
string
Sort by: createdAt, firstName, lastName





Response Fields




Field
Type
Description





id
string
Contact UUID



chapterId
string
Chapter UUID



firstName
string
First name



lastName
string
Last name



mobile
string
Phone (E.164 format)



email
string
Email address



dateOfBirth
string
null



status
string
Active, Failed, or Archived



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp



archivedAt
string
null
RESPONSE 200 Get All: {
    "data": [
        {
            "id": "contact_id",
            "firstName": "John",
            "lastName": "Claude",
            "mobile": "+15675671234",
            "email": "john@example.com",
            "dateOfBirth": "1900-01-01",
            "chapterId": "chapter_id",
            "status": "Active",
            "createdAt": "2020-01-01T00:00:00Z",
            "updatedAt": "2020-01-01T00:00:00Z",
            "archivedAt": null
        }
    ],
    "meta": {
        "pagination": {
            "total": 1,
            "limit": 10,
            "offset": 0,
            "sort": "createdAt",
            "order": "desc"
        }
    }
}

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/contacts/:contactId
Returns detailed information about a single contact within a chapter.

Response Fields




Field
Type
Description





id
string
Contact UUID



chapterId
string
Chapter UUID



firstName
string
First name



lastName
string
Last name



mobile
string
Phone (E.164 format)



email
string
Email address



dateOfBirth
string | null
YYYY-MM-DD format



status
string
Active or Archived



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp



archivedAt
string | null
ISO 8601 timestamp (if archived)
RESPONSE 200 Get: {
    "data": {
        "id": "contact_id",
        "firstName": "John",
        "lastName": "Claude",
        "mobile": "+15675671234",
        "email": "john@example.com",
        "dateOfBirth": "1900-01-01",
        "chapterId": "chapter_id",
        "status": "Active",
        "createdAt": "2020-01-01T00:00:00Z",
        "updatedAt": "2020-01-01T00:00:00Z",
        "archivedAt": null
    }
}

### Patch Contact — PATCH https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/contacts/:contactId
Patch contact's information.
REQUEST BODY: {
    "data": {
        "firstName": "John",
        "lastName": "Claude",
        "email": "john@example.com",
        "dateOfBirth": "2000-01-01"
    }
}
RESPONSE 202 Patch Contact: {
    "data": {
        "id": "contact_id",
        "firstName": "John",
        "lastName": "Claude",
        "mobile": "+15675671234",
        "email": "john@example.com",
        "dateOfBirth": "1900-01-01",
        "chapterId": "chapter_id",
        "status": "Active",
        "createdAt": "2020-01-01T00:00:00Z",
        "updatedAt": "2020-01-01T00:00:00Z",
        "archivedAt": null
    }
}

### Archive Contact — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/contacts/:contactId/archive
Archive a contact.
REQUEST BODY: {
    "reason": "ByCustomer"
}
RESPONSE 202 Archive Contact: {
    "data": {
        "id": "contact_id",
        "firstName": "John",
        "lastName": "Claude",
        "mobile": "+15675671234",
        "email": "john@example.com",
        "dateOfBirth": "1900-01-01",
        "chapterId": "chapter_id",
        "status": "Archived",
        "createdAt": "2020-01-01T00:00:00Z",
        "updatedAt": "2020-01-01T00:00:00Z",
        "archivedAt": null
    }
}

## Accounts
Accounts are bank accounts associated with a chapter. Each account provides full banking capabilities including deposits, withdrawals, balance tracking and card issuance.

Hierarchy

Chapter
└── Account(s)
    └── Contact (account owner)


Key Concepts

Account

An account is a full-service bank account within a chapter.


Has unique account and routing numbers



Maintains balance in real-time



Associated with an admin (account owner)



Supports deposits and withdrawals




Account Status




Status
Description





Open
Account is active and operational



Closed
Account has been closed



Frozen
Account is temporarily frozen





Balance Fields




Field
Description





balance
Total account balance in cents



hold
Funds on hold (pending transactions) in cents



available
Funds available for withdrawal (balance - hold)





Currency

All monetary values are in cents (USD). Example: $100.00 = 10000

### Bulk create accounts — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/accounts
Creates deposit accounts for contacts within a chapter.

Description

Provisions wallet or per-diem deposit accounts for specified contacts. Each contact can have multiple account types. Optionally creates a digital digital card for the account.

Maximum 10 items per request.

Request Fields




Field
Type
Required
Description





items
array
Yes
List of accounts to create (1-10 items)



items[].contactId
string
Yes
Contact UUID to create account for



items[].product
string
Yes
Account type: wallet or perdiem



items[].withDigitalCard
boolean
No
Create digital card (default: false)



idempotencyKey
string
Yes
UUID for request deduplication





Product Types




Product
Description





wallet
Account for business expenses



perdiem
Account for per-diem disbursements





Response Fields




Field
Type
Description





totalProcessed
number
Total items processed



successCount
number
Successful account creations



failedCount
number
Failed account creations



results
array
Result for each item



results[].contactId
string
Contact UUID



results[].accountId
string
Created account ID (if successful)



results[].product
string
Account type requested



results[].error
boolean
Whether creation failed



results[].errorCode
string
Error code (if failed)



results[].message
string
Result description



results[].accountCreated
boolean
Whether a new account was created



results[].cardCreated
boolean
Whether a digital card was created





Error Codes




Code
Description





CONTACT_NOT_FOUND
Contact does not exist in the chapter



PROVISION_FAILED
Account provisioning failed





Business Logic


Each contactId must be unique within the request

If a contact already has the requested account type, returns success with accountCreated: false

Digital cards can only be created for new accounts

All operations are idempotent based on the idempotencyKey

Partial success is possible - check individual results for status
REQUEST BODY: {
    "data": {
        "items": [
            {
                "contactId": "550e8400-e29b-41d4-a716-446655440000",
                "product": "wallet",
                "withDigitalCard": false
            },
            {
                "contactId": "550e8400-e29b-41d4-a716-446655440001",
                "product": "perdiem",
                "withDigitalCard": true
            }
        ],
        "idempotencyKey": "a2bfc40b-6ca5-4aed-8a5e-183877948649"
    }
}
RESPONSE 200 Bulk create accounts: {
    "data": {
        "totalProcessed": 3,
        "successCount": 2,
        "failedCount": 1,
        "results": [
            {
                "contactId": "550e8400-e29b-41d4-a716-446655440000",
                "accountId": "660e8400-e29b-41d4-a716-446655440001",
                "product": "wallet",
                "error": false,
                "message": "Account created successfully",
                "accountCreated": true,
                "cardCreated": false
            }
        ]
    }
}


### Get All — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/accounts
Returns all bank accounts belonging to a specific chapter. Each account is associated with a contact.

Query Parameters




Parameter
Type
Description





sort[field]
string
Sort by: createdAt (default)



include
string
Optional. limits — include ACH and wire transfer limits and current usage per account. Loaded only when requested





Response Fields




Field
Type
Description





id
string
Account ID



name
string
Account holder name



status
string
Open, Closed, or Frozen



accountNumber
string
Bank account number



routingNumber
string
Bank routing number



currency
string
Currency code (e.g., USD)



balance
number
Total balance in cents



hold
number
Amount on hold in cents



available
number
Available balance in cents



contactId
string
Contact UUID (account owner)



product
string
Account product type: checking, wallet, perdiem, hold, or org



createdAt
string
ISO 8601 timestamp



limits
object
Only with include=limits. ach and wire sections, each with limits (daily/monthly caps in cents) and totalsDaily / totalsMonthly usage. Best-effort: omitted for an account when the limits lookup fails
RESPONSE 200 Get All: {
    "data": [
        {
            "id": "account_id",
            "name": "Legal Name",
            "status": "Open",
            "accountNumber": "1234567890",
            "routingNumber": "123456789",
            "currency": "USD",
            "balance": 0,
            "hold": 0,
            "available": 0,
            "contactId": "contact_id",
            "product": "checking",
            "createdAt": "2023-04-01T00:00:00Z"
        }
    ],
    "meta": {
        "pagination": {
            "total": 1,
            "limit": 10,
            "offset": 0,
            "sort": "createdAt",
            "order": "desc"
        }
    }
}

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/accounts/:accountId
Returns detailed information about a single bank account within a chapter.

Response Fields




Field
Type
Description





id
string
Account ID



name
string
Account holder name



status
string
Open, Closed, or Frozen



accountNumber
string
Bank account number



routingNumber
string
Bank routing number



currency
string
Currency code (e.g., USD)



balance
number
Total balance in cents



hold
number
Amount on hold in cents



available
number
Available balance in cents



contactId
string
Contact UUID (account owner)



product
string
Account product type: checking, wallet, perdiem, hold, or org



createdAt
string
ISO 8601 timestamp



limits
object
ACH and wire transfer limits and current usage. Included by default on this endpoint — no opt-in required. Best-effort: if the limits lookup fails, the account is still returned and limits is omitted





Business Logic


Limits included by default: unlike the list endpoint (where limits requires include=limits), this endpoint always fetches them

limits.ach and limits.wire each carry limits (daily/monthly caps in cents) plus totalsDaily / totalsMonthly usage counters
RESPONSE 200 Get: {
    "data": {
        "id": "account_id",
        "name": "Legal Name",
        "status": "Open",
        "accountNumber": "1234567890",
        "routingNumber": "123456789",
        "currency": "USD",
        "balance": 0,
        "hold": 0,
        "available": 0,
        "contactId": "contact_id",
        "product": "checking",
        "createdAt": "2023-04-01T00:00:00Z"
    }
}

## Cards
Cards are debit cards issued to contacts within a chapter. Each card is linked to a deposit account and provides spending capabilities for the cardholder.

Hierarchy

Chapter
└── Contact
    └── Account
        └── Card(s)

Card Types




Type
Description





physical
Physical debit card shipped to a mailing address



digital
Virtual debit card available immediately





Note: Creating a physical card also creates a digital card if one does not already exist for the account. Physical card issuance must be enabled for the chapter; otherwise physical card creation fails.

Card Status




Status
Description





Active
Card is active and operational



Inactive
Card has not been activated (e.g., replacement awaiting activation)



Frozen
Card is temporarily suspended (reversible)



ClosedByCustomer
Card has been permanently closed



Stolen
Card was reported as stolen (irreversible)



Lost
Card was reported as lost (irreversible)



SuspectedFraud
Card was flagged for suspected fraud





Card Lifecycle

Create → Active
Active → Frozen (freeze) → Active (unfreeze)
Active → ClosedByCustomer (close)       ← irreversible, final
Active → Stolen (report-stolen)          ← irreversible, final
Active → Lost (report-lost)              ← irreversible, final
Frozen → ClosedByCustomer (close)       ← irreversible, final
Frozen → Stolen (report-stolen)          ← irreversible, final
Frozen → Lost (report-lost)              ← irreversible, final
Active or Inactive → Replace (re-ships same card credentials)

The replace endpoint ships a new physical card with the same card number, expiration date, and PIN as the original. It is only available for cards in Active or Inactive status — it cannot be used on stolen, lost, or closed cards. The replacement does not require activation. When a card is reported stolen or lost, a new digital card is automatically issued on the same account.

Deposit Products




Product
Create/Filter
Description





wallet
Yes
Account for business expenses



perdiem
Yes
Account for per-diem disbursements



checking
Yes
Chapter operating account (Admin contacts only)





Note: Checking cards are issued on the chapter's existing operating account and can only be ordered for contacts with the Admin role.

Card ID Format

Card identifiers are numeric strings (not UUIDs). Example: "123456"

### Authorizations
Authorizations are real-time card spend approval records. Each authorization represents a single attempt to charge a card — it can be Authorized (pending capture), Completed (captured into a transaction), Canceled (released without a charge), or Declined (rejected at the network).

These endpoints expose the same authorization data delivered via finance.authorization.* webhook events, so polling and webhooks remain interchangeable.

Hierarchy

Chapter
└── Card
    └── Authorization(s)

Authorization Statuses




Status
Description





Authorized
Approved at the network and pending capture. Funds are held against the available balance.



Completed
Captured into a transaction. The matching transaction is what hits the ledger.



Canceled
Released without a charge (e.g., merchant void, partial-clear release).



Declined
Rejected at the network. See declineReason for the cause.





Decline Reasons (sample)

declineReason is set when status === 'Declined'. Common values include:


InsufficientFunds

CardholderBlocked

SuspectedFraud

IncorrectPin

InvalidMerchant


The full set is determined by the upstream card network — treat unknown values as opaque strings.

Lifecycle

Authorized ─┬─► Completed (captured to transaction)
            ├─► Canceled  (released)
            └─► Declined  (rejected pre-approval)

A declined attempt does not transition; it is created in the Declined state directly.

#### List Authorizations — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/authorizations?pagination[limit]=10&pagination[offset]=0
Retrieves a paginated list of authorizations for a specific card within a chapter.

Returns authorizations across all statuses (Authorized, Completed, Canceled, Declined) for the supplied card. The shape mirrors the finance.authorization.* webhook payload, so partners can use a single parser for polling and event-driven flows.

Path Parameters




Parameter
Type
Description





chapterId
string
Chapter UUID



cardId
string
Card identifier





Query Parameters




Parameter
Type
Description





pagination[limit]
number
Page size (max 100)



pagination[offset]
number
Records to skip



sort[field]
string
Sort by: createdAt



sort[direction]
string
ASC or DESC (default DESC)



filter[status]
string
Authorized, Completed, Canceled, or Declined



filter[amount][min]
number
Minimum amount in cents



filter[amount][max]
number
Maximum amount in cents



filter[createdAt][min]
string
Start date (ISO 8601)



filter[createdAt][max]
string
End date (ISO 8601)



filter[merchantCategoryCode]
string | string[]
4-digit ISO 18245 MCC. Repeat the param to filter by multiple codes (?filter[merchantCategoryCode]=5411&filter[merchantCategoryCode]=5812). A comma-separated string (5411,5812) is also accepted.





Errors




Status
When





400
Invalid filter or pagination parameter (e.g. unsupported filter[status] value).



403
Partner does not have access to the chapter, or the card belongs to a different partner.



404
Card not found, or card belongs to a different chapter under the same partner.
RESPONSE 200 Success: {
  "data": [
    {
      "id": "14570033",
      "accountId": "549927",
      "cardId": "625742",
      "amount": 1500,
      "status": "Authorized",
      "recurring": false,
      "createdAt": "2026-04-15T18:31:42.000Z",
      "merchant": {
        "name": "Square Inc.",
        "mcc": 5812,
        "location": "San Francisco, CA, US"
      }
    },
    {
      "id": "14616890",
      "accountId": "549927",
      "cardId": "625742",
      "amount": 5838,
      "status": "Declined",
      "declineReason": "CardholderBlocked",
      "recurring": false,
      "createdAt": "2026-04-15T18:16:38.687Z",
      "merchant": {
        "name": "WOLT ENTERPRISES ISR",
        "mcc": 5812,
        "location": "TEL AVIV, IL"
      }
    }
  ],
  "meta": {
    "pagination": {
      "total": 2,
      "limit": 10,
      "offset": 0,
      "sort": "createdAt",
      "order": "DESC"
    }
  }
}

#### Get Authorization — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/authorizations/:authorizationId
Retrieves a single authorization by ID, scoped to the supplied card.

If the authorization exists but belongs to a different card (whether on this chapter or not), the endpoint returns 404 — existence is never confirmed across cards.

The response shape matches the list endpoint and the finance.authorization.* webhook payload.

Path Parameters




Parameter
Type
Description





chapterId
string
Chapter UUID



cardId
string
Card identifier



authorizationId
string
Authorization identifier





Errors




Status
When





403
Partner does not have access to the chapter, or the card belongs to a different partner.



404
Authorization, card, or chapter not found. Returned when the authorization belongs to a different card, or when the card belongs to a different chapter under the same partner.
RESPONSE 200 Success: {
  "data": {
    "id": "14570033",
    "accountId": "549927",
    "cardId": "625742",
    "amount": 1500,
    "status": "Authorized",
    "recurring": false,
    "createdAt": "2026-04-15T18:31:42.000Z",
    "merchant": {
      "name": "Square Inc.",
      "mcc": 5812,
      "location": "San Francisco, CA, US"
    }
  }
}
RESPONSE 404 Not Found: {
  "statusCode": 404,
  "message": "Authorization 14570033 not found"
}

### Get all — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards?pagination[limit]=10&pagination[page]=1
Retrieves a paginated list of cards for a chapter. Returns card details, balances, limits, and spending totals. Supports filtering by card status and deposit product type.

By default, returns cards for checking and wallet accounts only. To include perdiem cards, use filter[depositProduct][]=perdiem explicitly.

Query Parameters

Standard pagination and sorting supported.




Parameter
Type
Description





sort[field]
string
Sort by: createdAt



filter[status][]
string
Filter by status: Active, Inactive, Frozen (supports multiple)



filter[depositProduct][]
string
Filter by product: wallet, perdiem, checking (supports multiple)





Response Fields




Field
Type
Description





cardId
string
Card identifier (numeric)



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type: wallet, perdiem, or checking



expirationDate
string
Card expiration (format: YYYY-MM)



balance
number
Account balance in cents



available
number
Available balance in cents



status
string
Card status



type
string
physical or digital



pinStatus
string | null
Set, NotSet, or null



limits
object | null
Daily spending limits



limits.dailyWithdrawal
number
Daily ATM withdrawal limit in cents



limits.dailyPurchase
number
Daily purchase limit in cents



dailyTotals
object | null
Spending totals for today



dailyTotals.purchases
number
Total purchases today in cents



dailyTotals.withdrawals
number
Total withdrawals today in cents



monthlyTotals
object | null
Spending totals for the month



monthlyTotals.purchases
number
Total purchases this month in cents



monthlyTotals.withdrawals
number
Total withdrawals this month in cents

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId
Retrieves details of a specific card by ID.

Returns detailed information about a single card within a chapter, including its status, balance, limits, and spending totals.

Path Parameters




Parameter
Type
Description





chapterId
string
Chapter UUID



cardId
string
Card identifier (numeric)





Response Fields




Field
Type
Description





cardId
string
Card identifier (numeric)



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type: wallet, perdiem, or checking



expirationDate
string
Card expiration (format: YYYY-MM)



balance
number
Account balance in cents



available
number
Available balance in cents



status
string
Card status



type
string
physical or digital



pinStatus
string | null
Set, NotSet, or null



limits
object | null
Daily spending limits



limits.dailyWithdrawal
number
Daily ATM withdrawal limit in cents



limits.dailyPurchase
number
Daily purchase limit in cents



dailyTotals
object | null
Spending totals for today



dailyTotals.purchases
number
Total purchases today in cents



dailyTotals.withdrawals
number
Total withdrawals today in cents



monthlyTotals
object | null
Spending totals for the month



monthlyTotals.purchases
number
Total purchases this month in cents



monthlyTotals.withdrawals
number
Total withdrawals this month in cents

### Create Cards — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards
Issues physical or digital debit cards to specified contacts. Physical card creation also provisions a digital card if one does not already exist for the account. Up to 10 contacts per request.

Request Fields




Field
Type
Required
Description





type
string
Yes
Card type: physical or digital



depositProduct
string
Yes
Account type: wallet, perdiem, or checking



shippingType
string
Physical only
Shipping speed: standard



shippingAddress
object
Physical only
Delivery address (US only)



shippingAddress.street
string
Yes
Street address (max 255)



shippingAddress.street2
string
No
Apt/suite/unit (max 255)



shippingAddress.city
string
Yes
City (max 255)



shippingAddress.state
string
Yes
US state or territory code (2-letter, e.g., NY, PR)



shippingAddress.postalCode
string
Yes
ZIP code (12345 or 12345-6789)



items
array
Yes
Contacts to issue cards for (1-10 items)



items[].contactId
string
Yes
Contact UUID



items[].idempotencyKey
string
Yes
UUID v4 for deduplication



idempotencyKey
string
Yes
UUID v4 for request deduplication





Type-Specific Validation




Field
physical
digital





shippingType
Required
Not allowed



shippingAddress
Required
Not allowed





Example Request — Physical Card

{
    "data": {
        "type": "physical",
        "depositProduct": "wallet",
        "shippingType": "standard",
        "shippingAddress": {
            "street": "123 Main St",
            "street2": "Suite 100",
            "city": "New York",
            "state": "NY",
            "postalCode": "10001"
        },
        "items": [
            {
                "contactId": "550e8400-e29b-41d4-a716-446655440000",
                "idempotencyKey": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
            }
        ],
        "idempotencyKey": "c3d4e5f6-a7b8-9012-cdef-123456789012"
    }
}



Example Request — Digital Card

{
    "data": {
        "type": "digital",
        "depositProduct": "wallet",
        "items": [
            {
                "contactId": "550e8400-e29b-41d4-a716-446655440000",
                "idempotencyKey": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
            }
        ],
        "idempotencyKey": "c3d4e5f6-a7b8-9012-cdef-123456789012"
    }
}



Example Request — Checking Card (Admin contacts only)

{
    "data": {
        "type": "digital",
        "depositProduct": "checking",
        "items": [
            {
                "contactId": "550e8400-e29b-41d4-a716-446655440000",
                "idempotencyKey": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
            }
        ],
        "idempotencyKey": "c3d4e5f6-a7b8-9012-cdef-123456789012"
    }
}



Checking cards are issued on the chapter's operating account. The contact must have the Admin role — items for other contacts fail with a per-item error.

Response Fields




Field
Type
Description





totalProcessed
number
Total items processed



successCount
number
Successful card creations



failedCount
number
Failed card creations



results
array
Result for each item



results[].contactId
string
Contact UUID



results[].error
boolean
Whether creation failed



results[].message
string
Result description



results[].physicalCardCreated
boolean
Whether a physical card was created



results[].digitalCardCreated
boolean
Whether a digital card was created



results[].accountCreated
boolean
Whether a new deposit account was created



results[].cardId
string
Card identifier — physical card ID when type is physical, digital card ID when type is digital



results[].virtualCardId
string
Auto-created digital card ID (only present when type is physical)



results[].accountId
string
Deposit account ID



results[].balance
number
Account balance in cents



results[].depositProduct
string
Account type





Business Logic


Each contactId must be unique within the request



Each idempotencyKey must be unique within the request



Physical cards automatically create a digital card if one does not exist for the account



Digital card creation does not require shipping information



A deposit account is created automatically if the contact does not have one for the requested product (wallet and perdiem only)



Checking cards are issued on the chapter's existing operating account — no new account is created



Checking cards can only be ordered for contacts with the Admin role; other contacts fail with a per-item error



Partial success is possible — check individual results for status



Physical card issuance must be enabled for the chapter. If it is not, every physical item in the request fails and no cards are created — contact support to enable physical cards



The endpoint always responds with 200 OK, even when some or all items fail. Inspect results[].error and failedCount to determine per-item outcomes




Per-Item Errors

When an item fails, its results entry has error: true and a message describing the cause:




Cause
When





Contact not found
The contactId does not belong to the chapter



Checking card not permitted
depositProduct is checking but the contact does not have the Admin role



Physical cards unavailable
The chapter is not enabled for physical card issuance





Additional messages may be returned for other validation failures (e.g., account limits).
REQUEST BODY: {"data":{"type":"physical","depositProduct":"wallet","shippingType":"standard","shippingAddress":{"street":"123 Main St","street2":"Suite 100","city":"New York","state":"NY","postalCode":"10001"},"items":[{"contactId":"550e8400-e29b-41d4-a716-446655440000","idempotencyKey":"a1b2c3d4-e5f6-7890-abcd-ef1234567890"}],"idempotencyKey":"c3d4e5f6-a7b8-9012-cdef-123456789012"}}

### Freeze Card — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/freeze
Temporarily suspends a card, preventing all transactions until it is unfrozen. This operation is reversible.

Response Fields




Field
Type
Description





cardId
string
Card identifier



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type



expirationDate
string
Card expiration (format: YYYY-MM)



status
string
Updated status (Frozen)



type
string
physical or digital

### Unfreeze Card — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/unfreeze
Restores a frozen card to active status, allowing it to process transactions again. Only frozen cards can be unfrozen.

Response Fields




Field
Type
Description





cardId
string
Card identifier



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type



expirationDate
string
Card expiration (format: YYYY-MM)



status
string
Updated status (Active)



type
string
physical or digital

### Close Card — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/close
Permanently closes a card. This operation is irreversible — the card cannot be reactivated. Use this when a card is no longer needed.

Response Fields




Field
Type
Description





cardId
string
Card identifier



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type



expirationDate
string
Card expiration (format: YYYY-MM)



status
string
Updated status (ClosedByCustomer)



type
string
physical or digital

### Report Card Stolen — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/report-stolen
Immediately deactivates a card reported as stolen. This operation is irreversible — the card cannot be reactivated. An email notification is sent to the cardholder for physical cards. To issue a new card, use the Create Cards endpoint.

Response Fields




Field
Type
Description





cardId
string
Card identifier



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type



expirationDate
string
Card expiration (format: YYYY-MM)



status
string
Updated status (Stolen)



type
string
physical or digital

### Report Card Lost — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/report-lost
Immediately deactivates a card reported as lost. This operation is irreversible — the card cannot be reactivated. An email notification is sent to the cardholder for physical cards. To issue a new card, use the Create Cards endpoint.

Response Fields




Field
Type
Description





cardId
string
Card identifier



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number



accountId
string
Deposit account ID



depositProduct
string
Account type



expirationDate
string
Card expiration (format: YYYY-MM)



status
string
Updated status (Lost)



type
string
physical or digital

### Replace Card — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/cards/:cardId/replace
Ships a replacement physical card with the same card number, expiration date, and PIN as the original. Only available for cards in Active or Inactive status — cannot be used on stolen, lost, or closed cards. The replacement does not require activation.

Request Fields




Field
Type
Required
Description





shippingAddress
object
Yes
Delivery address for replacement card (US only)



shippingAddress.street
string
Yes
Street address (max 255)



shippingAddress.street2
string
No
Apt/suite/unit (max 255)



shippingAddress.city
string
Yes
City (max 255)



shippingAddress.state
string
Yes
US state or territory code (2-letter)



shippingAddress.postalCode
string
Yes
ZIP code (12345 or 12345-6789)





Response Fields




Field
Type
Description





cardId
string
Card identifier (same as original)



contactId
string
Contact UUID (card owner)



contactName
string
Full name of the cardholder



last4Digits
string
Last 4 digits of card number (unchanged)



accountId
string
Deposit account ID



depositProduct
string
Account type



expirationDate
string
Card expiration (format: YYYY-MM)



status
string
Card status



type
string
physical
REQUEST BODY: {"data":{"shippingAddress":{"street":"456 Oak Ave","street2":"Apt 2B","city":"Chicago","state":"IL","postalCode":"60601"}}}

## Collections
Collections are the objects that enable payment management and tracking. They serve as containers that organize related payment intents and provide structured oversight of payment initiatives.

Key Concepts

Collection

A Collection represents a specific payment request or fundraising campaign.


Defines the scope and parameters for payment processing

Acts as the organizational container for all related payment activities

Examples: "2025 Membership Dues", "Annual Fundraiser", "Event Registration"


Intent

An Intent belongs to a specific Collection (parent-child relationship).


Tracks payment activity from an individual contact

Represents the commitment and actual payments made

Links contact identity to their contribution history within a collection

Provides a unique paymentUrl for the contact to complete payment


Collection Types




Type
requestedAmount
Use Case





Fixed Amount
e.g. 10000
Membership fees, event tickets, fixed contributions



Open Amount
null
Fundraising campaigns, open-ended giving





Fixed Amount


Each contact can pay the exact amount once

Intent amount is locked to the collection's requestedAmount

Once paid, the intent is fulfilled and cannot be modified

Supports Installment payment plans to split the amount over time


Open Amount


Contacts can contribute any amount

Contacts can make multiple contributions

Intent amount can be updated before payment

Supports Recurring payment plans for ongoing contributions


Payment Plans

Payment plans allow contacts to pay over time instead of a single payment.




Plan Type
Collection Type
Behavior





Installment
Fixed Amount
Splits fixed amount into scheduled payments



Recurring
Open Amount
Ongoing contributions until cancelled or end of schedule





To enable payment plans, set recurringPaymentsEnabled: true when creating the collection.

Lifecycle

1. Create Collection
   ↓
2. Create Intent (assigns contact to collection)
   ↓
3. Contact visits paymentUrl
   ↓
4. Payment processed
   ↓
5. Intent status updated (Paid/Pending/Not Paid)

Payment Status Lifecycle

Payments are made by card or bank transfer (ACH). A payment's status only ever moves forward — it never returns to an earlier state. The available statuses depend on the method.


Mental model: Pending = accepted and queued · Processing = moving through the card processor or bank network · Succeeded = captured (card) / settled (bank transfer).





Status
Meaning
Card
Bank transfer





Pending
Accepted and queued; awaiting processing
transient¹
✓



Processing
Card authorized / bank transfer clearing — in progress
✓
✓



Succeeded
Captured (card) / settled (bank transfer)
✓
✓



Failed
Declined or rejected; payer may retry
✓
✓



Returned
Returned after settlement (bank return, or rarely a card dispute)
rare²
✓



Cancelled
Cancelled before settlement
rare²
✓



Refunded
A succeeded payment was fully refunded
✓
✓






¹ For card, Pending resolves within seconds and is effectively never observed via the API — treat Processing as the "in progress" state. For bank transfer, Pending is a normal state that can persist for several business days.

² Returned and Cancelled are common for bank transfers but rare for card (e.g. a chargeback can surface as Returned). Any payment may in principle reach any terminal status — handle them defensively regardless of method.


Card

Card payments are typically near-instant.

Pending (transient) ──▶ Processing ──▶ Succeeded ──▶ Refunded
        │                   │
        └────────┬──────────┘
                 ▼
               Failed




From → To
Cause





Pending → Processing
Authorized by the card issuer



Pending / Processing → Succeeded
Payment captured



Pending → Failed
Declined or voided before capture



Processing → Failed
Capture declined



Succeeded → Refunded
Refund completed






Rarely, a card payment may also end as Returned (dispute/chargeback) or Cancelled — treat both as terminal.


Bank transfer (ACH)

Bank transfers clear over several business days and may be returned even after showing Succeeded (e.g. insufficient funds or a closed account).

Pending ──▶ Processing ──▶ Succeeded ──▶ Refunded
   │            │             │
   │            │             └──▶ Returned
   ├──▶ Cancelled
   └──▶ Failed




From → To
Cause





Pending → Processing
Released to the bank network (clearing)



Processing → Succeeded
Transfer settled



Pending → Cancelled
Cancelled before submission



Pending → Failed
Rejected by the bank



Succeeded → Returned
Returned by the bank after settlement



Succeeded → Refunded
Refund completed





Notes


Treat Pending and Processing as non-final — wait for Succeeded, Failed, Cancelled, Returned, or Refunded (all terminal) before acting on the outcome.

Status notifications may arrive out of order; a fresh read always reflects the furthest-along state.

Bank transfers are not final at Succeeded — reconcile against later Returned events for a few business days after settlement.

For Open Amount collections a contact may make multiple payments on one intent; once any succeeds the intent is Paid and paidAmount reflects the total collected.


Intent status vs. payment status

The intent status is a rollup of its payments:




Intent status
When





Paid
At least one payment succeeded



Pending
A payment is in progress, none succeeded yet



Returned
A payment was returned



Cancelled
A payment was cancelled



Not Paid
No payment yet, or all attempts failed





Succeeded takes precedence over all other states.

Which status to rely on

The intent status only describes a single expected payment, so it is authoritative for fixed-amount requests but not for open-amount ones:


Fixed Amount collections — use the intent status. One payment is expected, so Paid means the intent is fulfilled. (Use the intent-level Pending as your "payment in progress" signal — not the transient payment-row Pending.)

Open Amount collections — a contact can make multiple payments, and the intent status latches to Paid as soon as any payment succeeds. It does not reflect later attempts, returns, or refunds. For these, read each payments[].status for per-payment outcomes and use paidAmount for the running total.

### Payments
Operations on individual payments within an intent.

Overview

Payments represent completed or attempted transactions for an intent. Each payment has a status indicating its current state in the payment lifecycle.

Payment Statuses




Status
Description





Pending
Payment initiated, awaiting processing



Processing
Payment is being processed



Succeeded
Payment completed successfully



Failed
Payment failed



Cancelled
Payment was cancelled



Returned
Payment was returned (e.g., ACH return)



Refunded
Payment was refunded

#### Refund — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId/payments/:paymentId/refund
Process a refund for a single payment.

Description

Initiates a refund for a specific payment within an intent. The refund is processed asynchronously - this endpoint returns a Processing status, and the final status is delivered via webhook.

Path Parameters




Parameter
Type
Description





chapterId
string
Chapter UUID



collectionId
string
Collection UUID



intentId
string
Intent UUID



paymentId
string
Payment UUID to refund





Request Fields




Field
Type
Required
Description





reason
string
Yes
Reason for the refund (1-500 characters)





Example Request

{
  "data": {
    "reason": "Customer requested refund"
  }
}



Response Fields




Field
Type
Description





paymentId
string
Payment UUID



status
string
Current status (Processing)



refundAmount
number
Amount refunded in cents



originalAmount
number
Original payment amount in cents



feeAmount
number
Fee amount in cents



feeCoveredByUser
boolean
Whether the fee was covered by the payer



refundedAt
string
ISO 8601 timestamp of refund initiation





Example Response

{
  "data": {
    "paymentId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "Processing",
    "refundAmount": 5000,
    "originalAmount": 5000,
    "feeAmount": 150,
    "feeCoveredByUser": true,
    "refundedAt": "2025-01-15T12:00:00.000Z"
  }
}



Business Logic

Eligibility Requirements




Condition
Requirement
Error





Payment status
Must be Succeeded
"Payment status 'X' is not eligible for refund"



Payment method
Must be Card
"Payment method 'X' is not eligible for refund"



Payment age
Within 30 days
"Payment is X days old. Refunds are only allowed within 30 days"



Existing refund
No pending refund
"Refund already in progress"



Previous reversal
No reversed refund
"Refund retry blocked due to previous reversal"



Chapter account
Banking must be enabled
"Refunds not available - chapter bank account not configured"



Account balance
Sufficient funds
"Insufficient funds in chapter account"





Refund Amount Calculation

The refund amount depends on who covered the processing fee:




Fee Coverage
Refund Behavior





User paid fees
Refund original amount only. Fee retained.



Chapter absorbed fees
Refund full amount user paid (includes fee).





Refund Processing Modes

The system determines the refund mode automatically based on where funds are in the settlement lifecycle:

Immediate Refund

When funds have not yet arrived at the chapter's destination account, the refund is processed as an immediate refund. This happens when the payment was recently captured and funds are still being settled.

Before the settlement cut-off, the refund can be processed immediately. After cut-off, the refund will only be available once the funds have arrived at the chapter's destination account.

Asynchronous Processing

Both refund modes are processed asynchronously:


Immediate response: Status = Processing



Background processing: Card refund initiated



Webhook notification: Final status delivered via collect.payment.refunded event




Webhook Events




Event
When





collect.refund.initiated
Refund processing started (includes isImmediateRefund flag)



collect.payment.refunded
Refund completed successfully



collect.refund.reversed
Refund failed and was reversed





Validation Chain

The endpoint validates the full resource hierarchy:


Partner has access to the chapter



Intent exists in the collection



Payment exists in the intent




Error Responses




Status
Error
Description





400
Validation error
Invalid request body or reason too long



403
Access denied
Partner does not have access to chapter



404
Not found
Intent or payment not found



422
Not eligible
Payment does not meet refund requirements
REQUEST BODY: {
    "data": {
        "reason": "Customer requested refund"
    }
}

#### Refund check — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId/payments/:paymentId/refund-check
Check if a payment is eligible for refund.

Description

Returns whether a payment can be refunded, along with the refund amount and balance availability. Use this endpoint to verify refund eligibility before calling the refund endpoint.

The canProcess field indicates whether calling the refund endpoint right now will succeed. When isEligible is true but canProcess is false, the refund will succeed once the blocking condition resolves (e.g., funds arrive). Poll this endpoint until canProcess becomes true before initiating the refund.

Path Parameters




Parameter
Type
Description





chapterId
string
Chapter UUID



collectionId
string
Collection UUID



intentId
string
Intent UUID



paymentId
string
Payment UUID





Response Fields




Field
Type
Description





isEligible
boolean
Whether the payment qualifies for refund



canProcess
boolean
Whether calling the refund endpoint right now will succeed



reason
string?
Why the payment is not eligible (only when isEligible: false)



isPendingRefund
boolean?
A refund is already in progress



hasBeenReversed
boolean?
A previous refund attempt was reversed



isImmediateRefundEligible
boolean?
Payment qualifies for immediate refund (funds not yet arrived)



refundAmount
number?
Amount that will be refunded in cents



originalPaymentAmount
number?
Original payment amount in cents



feeAmount
number?
Fee amount in cents



feeCoveredByUser
boolean?
Whether the fee was paid by the payer



raceConditionWarning
string?
Warning about an upcoming scheduled payment



nextPaymentDate
string?
ISO date of the next scheduled payment





Example Response - Ready to Process

{
  "data": {
    "isEligible": true,
    "canProcess": true,
    "isImmediateRefundEligible": true,
    "refundAmount": 5000,
    "originalPaymentAmount": 5150,
    "feeAmount": 150,
    "feeCoveredByUser": true
  }
}



Example Response - Eligible but Not Yet Processable

{
  "data": {
    "isEligible": true,
    "canProcess": false,
    "isImmediateRefundEligible": true,
    "refundAmount": 5000,
    "originalPaymentAmount": 5150,
    "feeAmount": 150,
    "feeCoveredByUser": true
  }
}



When canProcess is false, poll this endpoint periodically until it returns true before calling the refund endpoint.

Example Response - Regular Refund

{
  "data": {
    "isEligible": true,
    "canProcess": true,
    "isImmediateRefundEligible": false,
    "refundAmount": 5000,
    "originalPaymentAmount": 5000,
    "feeAmount": 150,
    "feeCoveredByUser": false
  }
}



Example Response - Not Eligible

{
  "data": {
    "isEligible": false,
    "canProcess": false,
    "reason": "Refund already in progress",
    "isPendingRefund": true
  }
}



Example Response - Payment Too Old

{
  "data": {
    "isEligible": false,
    "canProcess": false,
    "reason": "Payment is 35 days old. Refunds are only allowed within 30 days of payment."
  }
}



Business Logic

Eligibility vs Processability




isEligible
canProcess
Meaning





true
true
Refund endpoint will succeed



true
false
Payment qualifies but a transient condition prevents processing. Poll and retry.



false
false
Payment does not qualify for refund. Will not change.





Eligibility Requirements




Condition
Requirement





Payment status
Must be Succeeded



Payment method
Must be Card



Payment age
Within 30 days



Existing refund
No pending refund



Previous reversal
No reversed refund





Refund Amount Calculation

The refund amount depends on who covered the processing fee:




Fee Coverage
Refund Behavior





User paid fees
Refund original amount only. Fee retained.



Chapter absorbed fees
Refund full amount user paid (includes fee).





Validation Chain

The endpoint validates the full resource hierarchy:


Partner has access to the chapter



Intent exists in the collection



Payment exists in the intent




Error Responses




Status
Error
Description





401
Unauthorized
Invalid or missing token



403
Access denied
Partner does not have access to chapter



404
Not found
Intent, payment, or collection not found

#### List Payments — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId/payments
Lists the payments for a collect intent (paginated).

Description

Returns the payment transactions belonging to the intent. These are the same payment objects embedded in the intent response (payments[]), exposed as a paginated, sortable, filterable endpoint.

Query Parameters

Standard pagination is supported (pagination[limit], pagination[offset], pagination[page]).




Parameter
Type
Description





sort[field]
string
Sort by: createdAt, amount, status (default: createdAt)



sort[direction]
string
ASC or DESC (default: ASC; the list returns newest-first when no sort is given)



filter[status][]
string[]
Filter by payment status — array form, e.g. filter[status][]=Succeeded. Invalid values return 400. Allowed: Pending, Processing, Succeeded, Failed, Returned, Refunded, Cancelled



filter[method][]
string[]
Filter by payment method — array form, e.g. filter[method][]=Card. Allowed: Card, Ach, Cash, Check, Wire, Other





Response Fields

Returns the standard paginated envelope (data array + meta.pagination). Each item in data:




Field
Type
Description





id
string
Payment UUID



uid
string
Payment UUID (deprecated — use id)



method
string
Payment method (Card, Ach, Cash, Check, Wire, Other)



amount
number
Amount in cents



fee
number
Fee in cents



status
string
Payment status



incompleteReason
string
Failure reason (if applicable)



scheduledPaymentId
string | null
Scheduled-payment UUID (present only for payment-plan payments)



cardScheme
string
Card scheme/brand the payment was made with, for example Visa or Mastercard. Returned only for card payments



cardType
string
Card funding type: Credit, Debit, Prepaid, Charge or Deferred Debit. Returned only for card payments



methodLast4
string
Last 4 digits of the card number, for example 4242. Returned only for card payments



createdAt
string
ISO 8601 timestamp





The three card fields are omitted from the response when the payment was not made by card, for card payments recorded manually, and for card payments taken before card details were recorded.

Status

See the Collections folder overview → Payment Status Lifecycle for status values, definitions, and transitions (card and bank transfer).
RESPONSE 200 List Payments: {
    "data": [
        {
            "id": "1c9f2b6e-8a41-4c7d-9e35-6b2d8f0a71c4",
            "uid": "1c9f2b6e-8a41-4c7d-9e35-6b2d8f0a71c4",
            "method": "Ach",
            "amount": 5000,
            "fee": 0,
            "status": "Processing",
            "incompleteReason": null,
            "scheduledPaymentId": "7d3e9a52-40bf-4f68-a1c2-95d6e8b30f17",
            "createdAt": "2025-01-02T00:00:00Z"
        },
        {
            "id": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
            "uid": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
            "method": "Card",
            "amount": 5000,
            "fee": 150,
            "status": "Succeeded",
            "incompleteReason": null,
            "scheduledPaymentId": null,
            "cardScheme": "Visa",
            "cardType": "Credit",
            "methodLast4": "4242",
            "createdAt": "2025-01-01T00:00:00Z

#### Get Payment — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId/payments/:paymentId
Retrieves a single payment for a collect intent by ID.

Description

Returns one payment transaction belonging to the intent. Returns 404 if the payment is not part of the intent.

Path Parameters




Parameter
Type
Description





paymentId
string
Payment UUID (the id from the payments list or intent response)





Response Fields




Field
Type
Description





id
string
Payment UUID



uid
string
Payment UUID (deprecated — use id)



method
string
Payment method (Card, Ach, Cash, Check, Wire, Other)



amount
number
Amount in cents



fee
number
Fee in cents



status
string
Payment status



incompleteReason
string
Failure reason (if applicable)



scheduledPaymentId
string | null
Scheduled-payment UUID (present only for payment-plan payments)



cardScheme
string
Card scheme/brand the payment was made with, for example Visa or Mastercard. Returned only for card payments



cardType
string
Card funding type: Credit, Debit, Prepaid, Charge or Deferred Debit. Returned only for card payments



methodLast4
string
Last 4 digits of the card number, for example 4242. Returned only for card payments



createdAt
string
ISO 8601 timestamp





The three card fields are omitted from the response when the payment was not made by card, for card payments recorded manually, and for card payments taken before card details were recorded.

Status

See the Collections folder overview → Payment Status Lifecycle for status values, definitions, and transitions (card and bank transfer).
RESPONSE 200 Get Payment: {
    "data": {
        "id": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
        "uid": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
        "method": "Card",
        "amount": 5000,
        "fee": 150,
        "status": "Succeeded",
        "incompleteReason": null,
        "scheduledPaymentId": null,
        "cardScheme": "Visa",
        "cardType": "Credit",
        "methodLast4": "4242",
        "createdAt": "2025-01-01T00:00:00Z"
    }
}

### Payment Plans

#### Cancel Payment Plan — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId/payment-plans/stop-recurring
Cancels a payment plan for a collect intent.

Stops a recurring or installment payment plan associated with an intent. Once canceled, no further scheduled payments will be processed. Payments already completed are not affected.

Request Body

No request body required.

Response Fields




Field
Type
Description





intentId
string
Intent UUID



collectionId
string
Collection UUID



canceledAt
string
ISO 8601 timestamp of cancellation





Business Logic


Only active payment plans can be canceled



Completed payments within the plan are not reversed



After cancellation, the intent remains but no further scheduled payments are created

### Create Collection — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections
Creates a new collection to collect payments from chapter contacts.


Dues: Set requestedAmount to collect a specific amount

Donations: Omit requestedAmount for flexible contributions


Request Fields




Field
Type
Required
Description





title
string
Yes
Collection title (max 50 characters)



requestedAmount
number
No
Amount in cents (min: 100). Omit for donations



goalAmount
number
No
Fundraising goal in cents (display only)



recurringPaymentsEnabled
boolean
No
Enable payment plans (default: false). Allows Installments for Dues or Recurring for Donations





Response Fields




Field
Type
Description





id
string
Collection UUID



title
string
Collection title



requestedAmount
number | null
Fixed amount in cents. null for donations



goalAmount
number | null
Fundraising goal in cents



amountPaid
number
Total collected (starts at 0)



payers
number
Number of payers (starts at 0)



createdAt
string
ISO 8601 timestamp



descriptor
object
Preview of the text that will appear on a payer's card statement if they pay by card. Contains name and city





Business Logic




Type
requestedAmount
Result





Dues
>= 100
Fixed-amount. Each contact pays exact amount once



Donations
null / omitted
Open. Contacts can pay any amount, multiple times
REQUEST BODY: {
    "data": {
        "title": "Fundraising"
    }
}
RESPONSE 201 Create Collection: {
    "data": {
        "id": "collection_id",
        "title": "Fundraising",
        "requestedAmount": 1000,
        "paidAmount": 0,
        "payers": 0,
        "createdAt": "2025-01-01T00:00:00Z",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}

### Get All — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections
Returns all collections created within a chapter. Collections can be fixed-amount dues or open-amount donations.

Query Parameters




Parameter
Type
Description





search
string
Search by collection title



sort[field]
string
Sort by: name, createdAt





Response Fields




Field
Type
Description





id
string
Collection UUID



title
string
Collection title



requestedAmount
number
null



paidAmount
number
Total collected in cents



payers
number
Number of contacts who paid



createdAt
string
ISO 8601 timestamp





Business Logic




Type
requestedAmount
Behavior





Dues
> 0
Each contact pays exact amount once



Donations
null
Contacts can contribute any amount, multiple times
RESPONSE 200 Get All: {
    "data": [
        {
            "id": "collection_id",
            "title": "Fundraising",
            "requestedAmount": 0,
            "paidAmount": 0,
            "payers": 0,
            "createdAt": "2025-01-01T00:00:00Z"
        }
    ],
    "meta": {
        "pagination": {
            "total": 1,
            "limit": 10,
            "offset": 0,
            "sort": "createdAt",
            "order": "desc"
        }
    }
}

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId
Returns detailed information about a single collection including payment status and totals.

Response Fields




Field
Type
Description





id
string
Collection UUID



title
string
Collection title



requestedAmount
number | null
Fixed amount in cents. null for donations



goalAmount
number | null
Fundraising goal in cents



amountPaid
number
Total collected in cents



payers
number
Number of contacts who paid



createdAt
string
ISO 8601 timestamp



descriptor
object
Preview of the text that will appear on a payer's card statement if they pay by card. Contains name and city
RESPONSE 200 Get: {
    "data": {
        "id": "collection_id",
        "title": "Fundraising",
        "requestedAmount": 0,
        "paidAmount": 0,
        "payers": 0,
        "createdAt": "2025-01-01T00:00:00Z",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}

### Create Payment Intent — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents
Creates or updates an intent to assign a contact for payment. Auto-creates contact if not found by mobile number. For existing unpaid intents, updates instead of creating duplicate.

Request Fields




Field
Type
Required
Description





contactId
string
No*
Existing contact UUID



firstName
string
Yes*
First name (max 255 chars)



lastName
string
Yes*
Last name (max 255 chars)



email
string
Yes*
Email address



mobile
string
No
Phone in E.164 format (see note below)



dateOfBirth
string
No
YYYY-MM-DD format



requestedAmount
number
Yes
Amount in cents (min: 100)



payerIp
string
Yes
Payer's IP address



userConsented
boolean
Yes
Must be true



successUrl
string
No
Redirect URL after success



failureUrl
string
No
Redirect URL after failure



paymentPlan
object
No
Payment plan config





*Contact fields required when contactId is not provided.

Mobile Number: When mobile is not provided, a placeholder is generated internally. Contacts with placeholder mobiles:


Can receive payment requests via email

Cannot use phone-based authentication (OTP/SMS)

Will have a new contact created for each intent (no mobile-based deduplication)


Payment Plan Object




Field
Type
Required
Description





type
string
Yes
Installment (Dues) or Recurring (Donations)



timeInterval
string
Yes
Month, Year



paymentsCount
number
No
Number of payments (required for Installment)





Plan types by collection:


Dues: Use Installment - splits fixed amount into scheduled payments (up to 24)

Donations: Use Recurring - ongoing until cancelled, or set paymentsCount for a fixed number of total payments, a max of 24 periods can be specified for Month interval and 5 for Year


URL Placeholders

successUrl and failureUrl support: {collectionId}, {intentId}, {contactId}, {email}

Response Fields




Field
Type
Description





id
string
Intent UUID



contactId
string
Contact UUID



requestedAmount
number
Amount in cents



paidAmount
number
Amount paid in cents



firstName
string
Contact first name



lastName
string
Contact last name



email
string
Contact email



status
string
Intent status



payments
array
Payment transactions



createdAt
string
ISO 8601 timestamp



successUrl
string / null
Redirect URL (placeholders resolved)



failureUrl
string / null
Redirect URL (placeholders resolved)



paymentUrl
string
URL for contact to pay



paymentPlan
object / null
Payment plan details



descriptor
object
Preview of the text that will appear on the payer's card statement if they pay by card. Contains name and city





Business Logic

Contact Resolution


If contactId provided: Uses existing contact

If no contactId but mobile provided: Searches by mobile, creates contact if not found

If no contactId and no mobile: Creates new contact with placeholder mobile (no deduplication)


Intent Creation

When a contact already has an intent for the collection:




Collection Type
Intent Status
Behavior





Dues
Paid
Returns existing intent as-is (no duplicate)



Dues
Not Paid
Updates existing intent (except requestedAmount)



Donations
Any
Updates existing intent with new values





For Dues, once a contact has paid, subsequent calls return the existing paid intent without modification. This is because dues are one-time fixed payments.

For Donations, the existing intent is always updated since contacts can make multiple contributions.

If no intent exists, a new one is created and consent is recorded using the provided payerIp.

Amount Editability




Collection Type
Editable?
Behavior





Dues
No
Amount is fixed by collection



Donations
Yes
Amount can be set per intent





Payment Plan Restrictions


New intent: Plan stored for passthrough to Payment UI

Existing + no active plan: Plan stored for passthrough to Payment UI

Existing + Active/Paused plan: Error - "Cannot update payment plan while an active payment plan exists"

After first payment: PaymentPlan record created, cannot be replaced, further payments will be created as one-time payments
REQUEST BODY: {
    "data": {
        "firstName": "John",
        "lastName": "Claude",
        "email": "john@test.com",
        "mobile": "+12345678901",
        "dateOfBirth": "1980-01-01",
        "requestedAmount": 1000,
        "payerIp": "30.33.41.31",
        "userConsented": true,
        "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
        "failureUrl": "https://example.com/failure"
    }
}
RESPONSE 201 Create Payment Intent: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 1000,
        "createdAt": "2025-01-01T00:00:00Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/payment?intent={intentId}&collection={collectionId}",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}
RESPONSE 200 Create Payment Intent with Contact Id: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 100,
        "createdAt": "2025-11-27T00:00:00.000Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent=intent_id&collection=collection_id&contact=contact_id",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/collection/collection_id/embedded?collectintentuuid=intent_id",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}
RESPONSE 200 Create Payment Intent with Payment Plan: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 100,
        "createdAt": "2025-11-27T00:00:00.000Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent=intent_id&collection=collection_id&contact=contact_id",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/collection/collection_id/embedded?collectintentuuid=intent_id",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}
RESPONSE 200 Create Payment Intent with Contact Id and Payment Plan: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 100,
        "createdAt": "2025-11-27T00:00:00.000Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent=intent_id&collection=collection_id&contact=contact_id",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/collection/collection_id/embedded?collectintentuuid=intent_id",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}

### Get All Intents — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents
Returns all intents (payment assignments) for a collection. Each intent tracks a contact's payment status and provides a unique payment URL.

Query Parameters




Parameter
Type
Description





search
string
Search by contact firstName or lastName



sort[field]
string
Sort by: name, status, createdAt





Response Fields




Field
Type
Description





id
string
Intent UUID



contactId
string
Contact UUID



requestedAmount
number
Amount in cents



paidAmount
number
Amount paid in cents



firstName
string
Contact first name



lastName
string
Contact last name



email
string
Contact email



status
string
Intent status (see below)



payments
array
Payment transactions



payments[].id
string
Payment UUID



payments[].uid
string
Payment UUID (deprecated — use id)



payments[].method
string
Payment method (Card, Ach, Cash, Check, Wire, Other)



payments[].amount
number
Amount in cents



payments[].fee
number
Fee in cents



payments[].status
string
Payment status



payments[].incompleteReason
string
Failure reason (if applicable)



payments[].scheduledPaymentId
string | null
Scheduled-payment UUID (payment-plan payments only)



payments[].cardScheme
string
Card scheme/brand the payment was made with, for example Visa or Mastercard (card payments only)



payments[].cardType
string
Card funding type: Credit, Debit, Prepaid, Charge or Deferred Debit (card payments only)



payments[].methodLast4
string
Last 4 digits of the card number, for example 4242 (card payments only)



payments[].createdAt
string
ISO 8601 timestamp



createdAt
string
ISO 8601 timestamp



successUrl
string | null
Redirect URL after success



failureUrl
string | null
Redirect URL after failure



paymentUrl
string
URL for contact to pay





The three card fields are omitted when the payment was not made by card, for card payments recorded manually, and for card payments taken before card details were recorded.

Status

See the Collections folder overview → Payment Status Lifecycle and Intent status vs. payment status for all status values, definitions, and transitions (card and bank transfer).
RESPONSE 200 Get All Intents: {
    "data": [
        {
            "id": "intent_id",
            "contactId": "contact_id",
            "requestedAmount": 1000,
            "createdAt": "2025-01-01T00:00:00Z",
            "paidAmount": 0,
            "payments": [],
            "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
            "failureUrl": "https://example.com/failure",
            "paymentUrl": "https://example.com/payment?intent={intentId}&collection={collectionId}"
        }
    ],
    "meta": {
        "pagination": {
            "total": 1,
            "limit": 10,
            "offset": 0,
            "sort": "createdAt",
            "order": "desc"
        }
    }
}

### Get Intent — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId
Returns detailed information about a single intent including all payment transactions.

Response Fields




Field
Type
Description





id
string
Intent UUID



contactId
string
Contact UUID



requestedAmount
number
Amount in cents



paidAmount
number
Amount paid in cents



firstName
string
Contact first name



lastName
string
Contact last name



email
string
Contact email



status
string
Intent status



payments
array
Payment transactions



payments[].id
string
Payment UUID



payments[].uid
string
Payment UUID (deprecated — use id)



payments[].method
string
Payment method (Card, Ach, Cash, Check, Wire, Other)



payments[].amount
number
Amount in cents



payments[].fee
number
Fee in cents



payments[].status
string
Payment status



payments[].incompleteReason
string
Failure reason (if applicable)



payments[].scheduledPaymentId
string | null
Scheduled-payment UUID (payment-plan payments only)



payments[].cardScheme
string
Card scheme/brand the payment was made with, for example Visa or Mastercard (card payments only)



payments[].cardType
string
Card funding type: Credit, Debit, Prepaid, Charge or Deferred Debit (card payments only)



payments[].methodLast4
string
Last 4 digits of the card number, for example 4242 (card payments only)



payments[].createdAt
string
ISO 8601 timestamp



createdAt
string
ISO 8601 timestamp



successUrl
string | null
Redirect URL after success



failureUrl
string | null
Redirect URL after failure



paymentUrl
string
URL for contact to pay



paymentPlan
object | null
Payment plan details



descriptor
object
Preview of the text that will appear on the payer's card statement if they pay by card. Contains name and city





The three card fields are omitted when the payment was not made by card, for card payments recorded manually, and for card payments taken before card details were recorded.

Status

See the Collections folder overview → Payment Status Lifecycle and Intent status vs. payment status for all status values, definitions, and transitions (card and bank transfer).
RESPONSE 200 Get Intent: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 1000,
        "createdAt": "2025-01-01T00:00:00Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/payment?intent={intentId}&collection={collectionId}",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}
RESPONSE 200 Get Intent (paid by card): {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 5000,
        "paidAmount": 5000,
        "firstName": "Jane",
        "lastName": "Doe",
        "email": "jane.doe@example.com",
        "status": "Paid",
        "payments": [
            {
                "id": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
                "uid": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
                "method": "Card",
                "amount": 5000,
                "fee": 150,
                "status": "Succeeded",
                "incompleteReason": null,
                "scheduledPaymentId": null,
                "cardScheme": "Visa",
                "cardType": "Credit",
                "methodLast4": "4242",
                "createdAt": "2025-01-01T00:00:00Z"
            }
        ],
        "createdAt": "2025-01-01T00:00:00Z",
        "successUrl":

### Get Intent By Mobile — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/by-mobile/:mobileNumber
Looks up an intent using the contact's phone number. Useful for checking payment status without knowing the intent id.

Mobile Number Format

E.164 international format:


Starts with + followed by country code

No spaces, dashes, or parentheses


Examples:


US: +15551234567

UK: +447911123456


Response Fields




Field
Type
Description





id
string
Intent UUID



contactId
string
Contact UUID



requestedAmount
number
Amount in cents



paidAmount
number
Amount paid in cents



firstName
string
Contact first name



lastName
string
Contact last name



email
string
Contact email



status
string
Intent status



payments
array
Payment transactions



createdAt
string
ISO 8601 timestamp



successUrl
string
null



failureUrl
string
null



paymentUrl
string
URL for contact to pay



descriptor
object
Preview of the text that will appear on the payer's card statement if they pay by card. Contains name and city





Use Cases


Check payment status by phone number

Retrieve paymentUrl to send to contact


Status

See the Collections folder overview → Payment Status Lifecycle and Intent status vs. payment status for all status values, definitions, and transitions (card and bank transfer).
RESPONSE 200 Get Intent By Mobile: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 1000,
        "createdAt": "2025-01-01T00:00:00Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/payment?intent={intentId}&collection={collectionId}",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}

### Update Intent — PATCH https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/collections/:collectionId/intents/:intentId
Updates specific fields of an intent. Can modify payment URLs, contact info, amount (donations only), or payment plan.

Request Fields

All optional. At least one required.




Field
Type
Description





requestedAmount
number
Amount in cents (donations only)



successUrl
string
Redirect URL after success



failureUrl
string
Redirect URL after failure



firstName
string
Contact first name



lastName
string
Contact last name



email
string
Contact email



paymentPlan
object / null
Payment plan config. null to remove





Payment Plan Object




Field
Type
Required
Description





type
string
Yes
Installment (Dues) or Recurring (Donations)



timeInterval
string
Yes
Month, Year



paymentsCount
number
No
Number of payments (required for Installment)





Plan types by collection:


Dues: Use Installment - splits fixed amount into scheduled payments

Donations: Use Recurring - ongoing until cancelled, or set paymentsCount for a fixed number of total payments, a max of 24 periods can be specified for Month interval and 5 for Year


URL Placeholders

successUrl and failureUrl support: {collectionId}, {intentId}, {contactId}, {email}

Response Fields




Field
Type
Description





id
string
Intent UUID



contactId
string
Contact UUID



requestedAmount
number
Amount in cents



paidAmount
number
Amount paid in cents



firstName
string
Contact first name



lastName
string
Contact last name



email
string
Contact email



status
string
Intent status



payments
array
Payment transactions



createdAt
string
ISO 8601 timestamp



successUrl
string / null
Redirect URL



failureUrl
string / null
Redirect URL



paymentUrl
string
URL for contact to pay



paymentPlan
object / null
Payment plan details



descriptor
object
Preview of the text that will appear on the payer's card statement if they pay by card. Contains name and city





Business Logic

Prerequisites




Condition
Requirement
Error





Collection
Must be active
"Collect request is not active"



Intent (Dues)
Must be Not Paid
"Collect intent is not active"





For Dues collections, once a contact has paid, the intent is marked as fulfilled and can no longer be updated. This is because dues are one-time fixed payments.

For Donations collections, intents remain open for updates since contacts can make multiple contributions.

Amount Updates




Collection Type
Editable?
Behavior





Dues
No
Amount is fixed by collection, update is ignored



Donations
Yes
Amount can be updated freely





Payment Plan Updates




Scenario
Allowed?





Add new (no existing)
Yes



Update (no active plan)
Yes



Update (Active plan)
No - "Cannot update payment plan while an active payment plan exists"



Update (Paused plan)
No



Remove (null)
Yes* (only if no active/paused)





Lifecycle:


Before payment: Stored for passthrough on Payment UI

After first payment: PaymentPlan record created

Active plan: Cannot modify, only cancel
REQUEST BODY: {
    "data": {
        "requestedAmount": 1000,
        "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
        "failureUrl": "https://example.com/failure"
    }
}
RESPONSE 200 Update Intent: {
    "data": {
        "id": "intent_id",
        "contactId": "contact_id",
        "requestedAmount": 10000,
        "createdAt": "2025-01-01T00:00:00Z",
        "paidAmount": 0,
        "payments": [],
        "successUrl": "https://example.com/success?intent={intentId}&collection={collectionId}&contact={contactId}",
        "failureUrl": "https://example.com/failure",
        "paymentUrl": "https://example.com/payment?intent={intentId}&collection={collectionId}",
        "descriptor": {
            "name": "Crowded - Fundraising",
            "city": "Online"
        }
    }
}

## Collect Payments
Collect payments represent individual payment transactions made against collection intents. This endpoint provides a cross-chapter, cross-organization view of all payment activity for the authenticated partner.

Key Concepts


Cross-organization: Lists payments across all organizations and chapters managed by the partner

Filterable: Supports filtering by status, method, date range, refund status, organization, chapter, and redirect URL presence

Searchable: Search by payment ID, intent ID, collect request details, or payer information


Payment Status




Status
Description





Pending
Payment initiated, awaiting processing



Processing
Payment is being processed



Succeeded
Payment completed successfully



Failed
Payment failed



Returned
Payment was returned



Refunded
Payment has been refunded



Cancelled
Payment was cancelled





Payment Methods




Method
Description





Card
Credit/debit card payment



Ach
ACH bank transfer



Cash
Cash payment



Check
Check payment



Wire
Wire transfer



Other
Other payment method

### Get All — GET https://sandbox-api.crowdedfinance.com/api/v1/collect-payments?pagination[limit]=10&pagination[page]=1
Retrieves a paginated list of all collect payments for the authenticated partner, across every organization and chapter the partner manages. Supports extensive filtering and search.

Query Parameters

Standard pagination and sorting supported.




Parameter
Type
Description





search
string
Search by payment ID, intent ID, collect request ID/title/organization/chapter, or payer name/email (case-insensitive partial match)



sort[field]
string
Sort by: createdAt, amount, status, method



filter[status]
string | string[]
Filter by one or more payment statuses (Pending, Processing, Succeeded, Failed, Returned, Refunded, Cancelled)



filter[method]
string | string[]
Filter by one or more payment methods (Card, Ach, Cash, Check, Wire, Other)



filter[createdAt][min]
string
Payments created on or after this date (ISO 8601)



filter[createdAt][max]
string
Payments created on or before this date (ISO 8601)



filter[refundedAt]
boolean
true = refunded only, false = non-refunded only



filter[organizationId]
string
Filter by organization UUID



filter[chapterId]
string
Filter by chapter UUID



filter[hasUrls]
boolean
true = only payments whose intent has a successUrl or failureUrl configured, false = payments without redirect URLs





Response Fields




Field
Type
Description





id
string
Payment UUID



method
string
Payment method (Card, Ach, Cash, Check, Wire, Other)



methodLast4
string | undefined
Last 4 digits of payment method



cardScheme
string | undefined
Card brand (Visa, Mastercard, Amex, Discover, JCB, Diners Club)



status
string
Payment status (Pending, Processing, Succeeded, Failed, Returned, Refunded, Cancelled)



amount
number
Total amount charged in cents (includes fee)



standardAmount
number
Total amount in standard currency units



fee
number
Processing fee in cents



feeCovered
boolean
Whether the fee was covered by the payer



isReleased
boolean
Whether funds have been released



releasedAt
string | undefined
Date funds were released (ISO 8601)



releaseAccountId
string | undefined
Account ID where released funds were sent



isFeeTaken
boolean
Whether the processing fee has been collected



feeTakenAt
string | undefined
Date fee was collected (ISO 8601)



currency
string
Currency code (e.g., USD)



refundedAt
string | undefined
Timestamp of refund (ISO 8601)



refundReason
string | undefined
Reason for refund



incompleteReason
string | undefined
Reason for failure, return, or cancellation



isRefunded
boolean
Whether this payment has been refunded



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp



collectRequest
object
Collect request: { id, title, type, organizationName?, chapterName? } — type is one of Payment, Document, Fundraising, Goods



organization
object | undefined
{ id?, name? }



chapter
object | undefined
{ id?, name? }



payer
object | undefined
{ id?, firstName, lastName, email }



intent
object | undefined
{ id } — collect intent UUID



scheduledPayment
object | undefined
{ id, status, amount, fee?, paymentDate?, paymentPlan? } — present when part of a payment plan; status is Paid, Pending, or Failed





Payment Plan Object (scheduledPayment.paymentPlan)




Field
Type
Description





id
string
Payment plan UUID



status
string
Active, Paused, Canceled, Completed



type
string
Recurring or Installment



paymentsCount
number | undefined
Total number of payments



startDate
string
Start date



endDate
string | undefined
End date



timeInterval
string
Month or Year
RESPONSE 200 Success: {
    "data": [
        {
            "id": "9c1d4f6a-2e3b-47a8-9f21-5d8e7c3b1a90",
            "method": "Card",
            "methodLast4": "1111",
            "cardScheme": "Visa",
            "status": "Succeeded",
            "amount": 10300,
            "standardAmount": 103,
            "fee": 300,
            "feeCovered": true,
            "isReleased": true,
            "releasedAt": "2025-01-03T09:15:00.000Z",
            "releaseAccountId": "account_id",
            "isFeeTaken": true,
            "feeTakenAt": "2025-01-02T09:15:00.000Z",
            "currency": "USD",
            "isRefunded": false,
            "createdAt": "2025-01-01T14:25:30.000Z",
            "updatedAt": "2025-01-03T09:15:00.000Z",
            "collectRequest": {
                "id": "3f8a2c1b-9d4e-4f6a-8b2c-1e5d7a9c3b41",
                "title": "Spring Dues 2025",
                "type": "Payment",


## Counterparties
Saved external bank accounts (payees) for a chapter's checking account — the same view the chapter's treasurer has.

Overview

A counterparty is a reusable payee. Two types appear in the list:


recipient — an external bank account saved as a payee. Partners can create, read, update (address), and delete these.

linkedAccount — a bank account the chapter linked in the portal. Read-only through this API: it can receive achCounterparty credit payments, but it is created, re-linked, and deleted in the portal.


Saved counterparties are referenced by id from the ACH Counterparty Payment and Wire Counterparty Payment requests, and from the Quote ACH Payment / Quote Wire Payment requests.

Operations




Endpoint
Description





POST /chapters/:id/counterparties
Create a saved recipient



GET /chapters/:id/counterparties
List the chapter's counterparties



GET /chapters/:id/counterparties/:counterpartyId
Get a counterparty



PATCH /chapters/:id/counterparties/:counterpartyId
Update the mailing address (enables wires)



DELETE /chapters/:id/counterparties/:counterpartyId
Delete a saved recipient





Wire eligibility

Wire payments require a mailing address on file. A counterparty created without an address can receive ACH credits immediately; add an address at creation or via Update Counterparty Address to make it wire-eligible (wireEligible: true).

Credits only

Counterparties saved through this API can only receive money. ACH debits (pulling funds from the counterparty) are not supported anywhere on this API.

Shared with the portal

Partners and treasurers see one list: counterparties created here appear in the chapter's portal, and portal-created recipients and linked accounts appear here. Deleting a counterparty follows the same rules as the portal — the underlying payee record is removed only when no other chapter still uses it.

### Create Counterparty — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/counterparties
Save an external bank account as a reusable recipient.

Creates a recipient counterparty for the chapter. The saved counterparty can then be paid by id with the ACH Counterparty Payment and Wire Counterparty Payment requests, and priced with the quote requests.

Include a mailing address to make the counterparty wire-eligible immediately, or add one later via Update Counterparty Address.

Request Fields




Field
Type
Required
Description





name
string
Yes
Account holder name (max 255 characters). Person counterparties require at least a first and last name (2+ words)



routingNumber
string
Yes
ABA routing number (exactly 9 digits)



accountNumber
string
Yes
Bank account number (3-17 digits)



accountType
string
Yes
Checking or Savings



type
string
Yes
Person or Business



nickname
string
Yes
Display name for the counterparty (max 128 characters). Shown in lists here and in the chapter's portal



address
object
No
Mailing address — required for wire payments



address.street
string
Yes*
Street address (max 100 characters)



address.street2
string
No
Additional address line (max 100 characters)



address.city
string
Yes*
City (max 100 characters)



address.state
string
Yes*
USPS two-letter state code



address.postalCode
string
Yes*
ZIP or ZIP+4



address.country
string
No
ISO 3166-1 alpha-2 country code. Only US is supported. Defaults to US



idempotencyKey
string
Yes
UUID v4. Reusing the same key is safe — the counterparty is created at most once





* required when address is present.

Response Fields




Field
Type
Description





id
string
Counterparty ID — the id the payment types reference



type
string
recipient



nickname
string | null
Display name



name
string
Account holder name



accountLast4
string
Last 4 digits of the account number. The full number is never returned



routingNumber
string
ABA routing number



accountType
string
Checking or Savings



entityType
string
Person or Business



hasAddress
boolean
Whether a mailing address is stored



address
object | null
The stored address, when present



wireEligible
boolean
Whether wire payments can target this counterparty (requires a stored address)



managed
boolean
true for counterparties synced from the organization — these cannot be edited here



createdAt
string
ISO 8601 timestamp





Error Codes




Code
HTTP Status
Description





Validation error
400
A field failed validation (routing/account format, name rules, address)



COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter



Not found
404
The chapter does not exist or has no banking configured



DUPLICATE_REQUEST
409
Another create with the same idempotency key is in flight — retry shortly





Business Logic


Deduplication: creating a counterparty with the same routing and account number the chapter's banking customer already has reuses the existing payee instead of creating a duplicate — the response returns the existing id. A reused payee keeps its existing display name; the nickname in the request applies only to newly created payees

Portal visibility: the counterparty appears in the chapter's portal with the given nickname, and treasurers can use it there

Address is local: the mailing address is stored by Crowded for wire composition; it is not part of the ACH network record

Notification: chapter treasurers are notified of the new counterparty by email, subject to the partner's email-notification configuration

Credits only: saved counterparties can only receive money — ACH debits are not supported
REQUEST BODY: {
    "data": {
        "name": "Acme Supplies LLC",
        "routingNumber": "812345678",
        "accountNumber": "2000000002",
        "accountType": "Checking",
        "type": "Business",
        "nickname": "Acme wholesale",
        "address": {
            "street": "1 Main St",
            "city": "New York",
            "state": "NY",
            "postalCode": "10001"
        },
        "idempotencyKey": "7f6bd1ce-8c4a-4b8e-9d3f-2a1b3c4d5e6f"
    }
}
RESPONSE 201 Counterparty created: {
    "data": {
        "id": "2213866",
        "type": "recipient",
        "nickname": "Acme wholesale",
        "name": "Acme Supplies LLC",
        "accountLast4": "0002",
        "routingNumber": "812345678",
        "accountType": "Checking",
        "entityType": "Business",
        "hasAddress": true,
        "address": {
            "street": "1 Main St",
            "street2": null,
            "city": "New York",
            "state": "NY",
            "postalCode": "10001"
        },
        "wireEligible": true,
        "managed": false,
        "createdAt": "2026-08-21T03:15:00.000Z"
    }
}

### Get all Counterparties — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/counterparties?pagination[limit]=10&pagination[offset]=0
List the chapter's counterparties — the same view the treasurer has.

Returns saved recipients and portal-linked bank accounts for the chapter, newest first. Linked accounts are read-only through this API but can receive ACH Counterparty Payment credit payments.

Query Parameters

Standard pagination supported.




Parameter
Type
Description





filter[type]
string
Filter by counterparty type: recipient or linkedAccount



filter[search]
string
Substring match on name or nickname (max 100 characters)



pagination[limit]
number
Records per page



pagination[offset]
number
Records to skip





Response Fields




Field
Type
Description





counterparties
array
List of counterparty resources — see the Get Counterparty request for the full field set



meta.limit
number
Records per page



meta.offset
number
Records skipped



meta.count
number
Number of records in this page





Error Codes




Code
HTTP Status
Description





COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter





Business Logic


Treasurer view: the list matches what the chapter sees in the portal — partner-created, treasurer-created, and organization-synced counterparties all appear

Newest first: results are ordered by creation time, descending

Masked account numbers: entries carry accountLast4 only — full account numbers are never returned by this API

Per-member payees excluded: recipients saved by individual chapter members for their own use are not part of this list

### Get Counterparty — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/counterparties/{{counterparty_id}}
Retrieve a single counterparty.

Returns one chapter counterparty by ID — a saved recipient or a portal-linked bank account.

Response Fields




Field
Type
Description





id
string
Counterparty ID



type
string
recipient or linkedAccount



nickname
string | null
Display name given when the counterparty was saved



name
string
Account holder name



accountLast4
string
Last 4 digits of the account number



routingNumber
string
ABA routing number



accountType
string
Checking, Savings, or Loan



entityType
string
Person, Business, or Unknown (some linked accounts)



hasAddress
boolean
Whether a mailing address is stored



address
object | null
The stored mailing address, when present



address.street
string
Street address



address.street2
string | null
Additional address line



address.city
string
City



address.state
string
USPS two-letter state code



address.postalCode
string
ZIP or ZIP+4



wireEligible
boolean
Whether wire payments can target this counterparty



managed
boolean
true for organization-synced counterparties



createdAt
string
ISO 8601 timestamp





Error Codes




Code
HTTP Status
Description





COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter



Not found
404
The counterparty does not exist or does not belong to this chapter





Business Logic


Scoped visibility: only the chapter's own counterparties are visible; anything else returns 404 — existence is never confirmed for other chapters' counterparties

### Update Counterparty Address — PATCH https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/counterparties/{{counterparty_id}}
Store or replace a counterparty's mailing address — the step that enables wire payments.

Sets the mailing address on a saved counterparty. Wires are composed from the stored bank details plus this address, so a counterparty without one cannot be wired to (Wire Counterparty Payment returns COUNTERPARTY_ADDRESS_REQUIRED).

The address is the only mutable field. Bank details and nickname are fixed at creation — to change them, create a new counterparty and delete the old one.

Request Fields




Field
Type
Required
Description





address
object
Yes
The full replacement address



address.street
string
Yes
Street address (max 100 characters)



address.street2
string
No
Additional address line (max 100 characters)



address.city
string
Yes
City (max 100 characters)



address.state
string
Yes
USPS two-letter state code



address.postalCode
string
Yes
ZIP or ZIP+4



address.country
string
No
ISO 3166-1 alpha-2 country code. Only US is supported. Defaults to US





Response Fields

The updated counterparty resource — the same shape as the Get Counterparty request, with hasAddress and wireEligible reflecting the new address.

Error Codes




Code
HTTP Status
Description





Validation error
400
The address failed validation



CANNOT_UPDATE_LINKED
400
Linked bank accounts are managed in the portal and cannot be updated through this API



COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter



Not found
404
The counterparty does not exist or does not belong to this chapter





Business Logic


Full replacement: the address is replaced as a unit — partial address updates are not supported

Address is local: the address is stored by Crowded for wire composition only; updating it never touches the ACH network record
REQUEST BODY: {
    "data": {
        "address": {
            "street": "1 Main St",
            "city": "New York",
            "state": "NY",
            "postalCode": "10001"
        }
    }
}

### Delete Counterparty — DELETE https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/counterparties/{{counterparty_id}}
Remove a saved recipient.

Deletes a recipient counterparty from the chapter. Returns 204 No Content on success.

Linked bank accounts (type: linkedAccount) carry portal-managed link state and cannot be deleted through this API — remove them in the portal.

Response

204 No Content — no body.

Error Codes




Code
HTTP Status
Description





CANNOT_DELETE_LINKED
400
Linked bank accounts are managed in the portal and cannot be deleted through this API



COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter



Not found
404
The counterparty does not exist or does not belong to this chapter



DUPLICATE_REQUEST
409
Another delete of this counterparty is in flight — retry shortly





Business Logic


Same rules as the portal: any of the chapter's recipients can be deleted, including treasurer-created and organization-synced ones

Shared payees survive: when other chapters — or individual chapter members' saved payees — still use the same underlying payee, only this chapter's chapter-level references are removed; the payee record itself is deleted only when nothing else references it. All of this chapter's chapter-level references are removed together, including ones created in the portal for the same payee

Payments are unaffected: deleting a counterparty never cancels payments already originated to it; in-flight payments settle normally

History: payments to a deleted counterparty keep their counterpartyId on reads and webhooks

## Payments
These endpoints allow partners to manually manage funds collected through payment intents. When fund holding is enabled for a partner, automatic fund release is disabled and partners must explicitly transfer funds to the chapter or to a partner account.

Flow

Both operations follow the same flow:


Consolidation - All held funds are consolidated



Validation - Amount and destination account are validated



Transfer - Book transfer executed to destination




Requirements


Fund holding must be enabled for the partner



Partner must have access to the chapter



Chapter must have banking enabled

### Book Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/payments
Execute bulk book payments between chapter checking and contact accounts.

This endpoint accepts book, ach, or wire payments, discriminated by the type field. This request documents the book variant — instant internal transfers between a chapter's checking account and contact accounts (Wallet or PerDiem). For payments to an external bank account, see the ACH Payment and Wire Payment requests.

Each book payment must have the chapter checking account on one side. Payments are processed with continue-on-error semantics — partial success is possible.

Maximum 10 payments per request.

Request Fields




Field
Type
Required
Description





type
string
Yes
Payment type. book for this variant — see also the ACH Payment and Wire Payment requests



payments
array
Yes
List of payments (1-10 items)



payments[].sourceAccountId
string
Yes
Source account ID



payments[].destinationAccountId
string
Yes
Destination account ID



payments[].amount
integer
Yes
Amount in cents (must be positive)



payments[].description
string
Yes
Payment description (max 80 characters)



payments[].idempotencyKey
string
Yes
UUID v4 for deduplication (unique per payment)





Response Fields




Field
Type
Description





chapterId
string
Chapter UUID



totalProcessed
number
Total payments processed



successCount
number
Successful payments



failedCount
number
Failed payments



results
array
Per-payment results



results[].index
number
Index in original request array



results[].status
string
success or failed



results[].paymentId
string
Payment ID (if successful)



results[].paymentStatus
string
Pending, Sent, or Rejected (if successful)



results[].error
string
Error message (if failed)



results[].errorCode
string
Error code (if failed)





Error Codes




Code
Description





NOT_FOUND
Account not found



VALIDATION_ERROR
Invalid account type or ownership



INSUFFICIENT_FUNDS
Source account lacks sufficient balance



ACCOUNT_UNAVAILABLE
Account is frozen, closed, or blocked



DUPLICATE_PAYMENT
Idempotency key already used



PAYMENT_FAILED
Payment could not be processed





Business Logic


Chapter checking required: One side of each payment must be the chapter's checking account

Valid counterparties: Wallet or PerDiem account within the same chapter

Bidirectional transfers: Supports both outbound (checking → contact) and inbound (contact → checking)

Account validation: All accounts are validated upfront before any payments execute

Continue-on-error: Individual payment failures do not stop other payments

Idempotency: Keys are scoped to chapter to prevent cross-chapter collisions
REQUEST BODY: {
    "data": {
        "type": "book",
        "payments": [
            {
                "sourceAccountId": "123456",
                "destinationAccountId": "789012",
                "amount": 10000,
                "description": "Q1 Per Diem",
                "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000"
            }
        ]
    }
}

### ACH Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments
Originate a single outbound ACH credit payment from the chapter's checking account to an external bank account.

Sends this request to the same endpoint as book payments, with type set to ach. Unlike book payments, the counterparty is not an existing account in the chapter — it is supplied inline as bank details for an external recipient. Exactly one payment is allowed per request.

Request Fields




Field
Type
Required
Description





type
string
Yes
Must be ach



payments
array
Yes
Exactly 1 payment per request



payments[].counterparty
object
Yes
Recipient bank details



payments[].counterparty.name
string
Yes
Recipient name (max 255 characters). Person counterparties require at least a first and last name (2+ words)



payments[].counterparty.routingNumber
string
Yes
Receiving bank ABA routing number (exactly 9 digits)



payments[].counterparty.accountNumber
string
Yes
Receiving bank account number (3-17 digits)



payments[].counterparty.accountType
string
Yes
Checking or Savings



payments[].counterparty.type
string
Yes
Person or Business



payments[].amount
integer
Yes
Amount in cents. Minimum 100 ($1.00)



payments[].description
string
Yes
Statement description (max 10 ASCII characters). Appears on the recipient's bank statement



payments[].addenda
string
No
Additional payment description (max 80 ASCII characters). Not all receiving institutions present it to the recipient



payments[].sameDay
boolean
No
Request same-day ACH processing. Honored only when the source account's deposit product supports it



payments[].applyFee
boolean
Yes
true: the chapter account is charged the origination fee. false: no fee is charged to the chapter — the partner is billed separately by Crowded. When false, the response fee.amount is indicative only



payments[].idempotencyKey
string
Yes
UUID v4. Keys are effective for approximately 48 hours; reusing the same key within that window is safe and the payment occurs at most once. Use a fresh UUID for each new payment intent





Response Fields

The response is the payment resource — the same shape returned by the Get all Payments and Get Payment requests, and delivered as the finance.ach_payment.* webhook payload.




Field
Type
Description





id
string
Payment ID



method
string
ach



status
string
pending, processing, sent, returned, canceled, or failed



amount
number
Amount in cents



description
string
Statement description



addenda
string | null
Additional description, when provided



sameDay
boolean
Whether same-day ACH was requested



counterparty
object
Recipient summary



counterparty.name
string
Recipient name



counterparty.accountLast4
string
Last 4 digits of the receiving account number



counterparty.accountType
string
Checking or Savings



fee
object
Fee outcome



fee.status
string
charged, failed, partner_billed, or none



fee.amount
number
Fee amount in cents. Settled when status is charged; indicative when partner_billed



fee.feeType
string
Resolved fee type



totalDebit
number
Total debited from the chapter account: amount + fee when the chapter pays the fee, amount otherwise



returnReason
string | null
ACH return reason code (R01–R85), present when status is returned



createdAt
string
ISO 8601 timestamp





Note: A declined origination returns HTTP 2xx with the payment resource's status set to failed — not an HTTP error. Inspect status to detect the decline.

Error Codes




Code
HTTP Status
Description





ACH_NOT_ENABLED
403
ACH origination is not enabled for this chapter



SAME_DAY_ACH_NOT_SUPPORTED
400
sameDay was requested but the account's deposit product does not support it



INVALID_COUNTERPARTY
400
The counterparty is invalid (for example, it resolves to the originating account itself)



LIMIT_EXCEEDED
400
Amount exceeds the account's ACH limits



INSUFFICIENT_FUNDS
400
The source account balance does not cover the amount plus the fee (when the chapter pays it)



DUPLICATE_REQUEST
409
Another request with the same idempotency key is being processed right now. Retry shortly — the retry returns the payment the first request produced





Business Logic


One payment per request: unlike book payments, which allow up to 10 items, ACH and wire requests carry exactly one payment

Fee timing: the origination fee is charged from the chapter checking account after the payment is accepted, not upfront

Returns are not free: a returned payment charges the standard return fee to the chapter; the origination fee already charged is not reversed

Instant-transfer conversion: when the counterparty resolves to an internal Crowded account on the same bank, the payment may execute as a free instant transfer instead of a network ACH — the response still reports method: "ach", with status: "sent" and no fee

Idempotency scope: keys are scoped to the chapter, so the same key can be reused safely across different chapters

Concurrent duplicates: while a request is in flight, a second request with the same idempotency key is rejected with 409 DUPLICATE_REQUEST instead of being processed twice; retrying after the first request completes returns the payment it produced

Cancellation: ACH payments are cancellable only while status is pending — see the Cancel Payment request
REQUEST BODY: {
    "data": {
        "type": "ach",
        "payments": [
            {
                "counterparty": {
                    "name": "Jane Doe",
                    "routingNumber": "812345678",
                    "accountNumber": "1000000001",
                    "accountType": "Checking",
                    "type": "Person"
                },
                "amount": 125000,
                "description": "Invoice 42",
                "addenda": "PO-778899 October services",
                "sameDay": false,
                "applyFee": true,
                "idempotencyKey": "7f6bd1ce-8c4a-4b8e-9d3f-2a1b3c4d5e6f"
            }
        ]
    }
}
RESPONSE 201 ACH payment created: {
    "data": {
        "id": "1287345",
        "method": "ach",
        "status": "pending",
        "amount": 125000,
        "description": "Invoice 42",
        "addenda": "PO-778899 October services",
        "sameDay": false,
        "counterparty": {
            "name": "Jane Doe",
            "accountLast4": "0001",
            "accountType": "Checking"
        },
        "fee": {
            "status": "charged",
            "amount": 249,
            "feeType": "originatedACH"
        },
        "totalDebit": 125249,
        "returnReason": null,
        "createdAt": "2026-08-20T15:04:05.000Z"
    }
}

### ACH Counterparty Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments
Originate an outbound ACH credit payment to a saved counterparty, referenced by id.

Sends this request to the same endpoint as book payments, with type set to achCounterparty. Instead of supplying bank details inline (the ACH Payment request), the payment targets a saved counterparty by its id (see the Counterparties requests). Both recipient and linkedAccount counterparties can be paid. Exactly one payment is allowed per request.

The resulting payment IS an ACH payment: it reads back with method: "ach" from the Get all Payments and Get Payment requests, emits finance.ach_payment.* webhook events, and can be canceled under the same rules — with a counterpartyId field echoing the saved counterparty on every surface.

Request Fields




Field
Type
Required
Description





type
string
Yes
Must be achCounterparty



payments
array
Yes
Exactly 1 payment per request



payments[].counterpartyId
string
Yes
ID of a saved counterparty belonging to this chapter



payments[].amount
integer
Yes
Amount in cents. Minimum 100 ($1.00)



payments[].description
string
Yes
Statement description (max 10 ASCII characters). Appears on the recipient's bank statement



payments[].addenda
string
No
Additional payment description (max 80 ASCII characters). Not all receiving institutions present it to the recipient



payments[].sameDay
boolean
No
Request same-day ACH processing. Honored only when the source account's deposit product supports it



payments[].applyFee
boolean
Yes
true: the chapter account is charged the origination fee. false: no fee is charged to the chapter — the partner is billed separately by Crowded. When false, the response fee.amount is indicative only



payments[].idempotencyKey
string
Yes
UUID v4. Keys are effective for approximately 48 hours; reusing the same key within that window is safe and the payment occurs at most once. Use a fresh UUID for each new payment intent





Response Fields

The response is the payment resource — the same shape returned by the Get all Payments and Get Payment requests, and delivered as the finance.ach_payment.* webhook payload.




Field
Type
Description





id
string
Payment ID



method
string
ach — the payment is a regular ACH payment



status
string
pending, processing, sent, returned, canceled, or failed



amount
number
Amount in cents



description
string
Statement description



addenda
string | null
Additional description, when provided



sameDay
boolean
Whether same-day ACH was requested



counterpartyId
string
The saved counterparty the payment was sent to



counterparty
object
Recipient summary



counterparty.name
string
Recipient name



counterparty.accountLast4
string
Last 4 digits of the receiving account number



counterparty.accountType
string
Checking or Savings



fee
object
Fee outcome



fee.status
string
charged, failed, partner_billed, or none



fee.amount
number
Fee amount in cents. Settled when status is charged; indicative when partner_billed



fee.feeType
string
Resolved fee type



totalDebit
number
Total debited from the chapter account: amount + fee when the chapter pays the fee, amount otherwise



returnReason
string | null
ACH return reason code (R01–R85), present when status is returned



createdAt
string
ISO 8601 timestamp





Note: A declined origination returns HTTP 2xx with the payment resource's status set to failed — not an HTTP error. Inspect status to detect the decline.

Error Codes




Code
HTTP Status
Description





COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter



ACH_NOT_ENABLED
403
ACH origination is not enabled for this chapter



SAME_DAY_ACH_NOT_SUPPORTED
400
sameDay was requested but the account's deposit product does not support it



INVALID_COUNTERPARTY
400
The counterparty is invalid (for example, it resolves to the originating account itself)



LIMIT_EXCEEDED
400
Amount exceeds the account's ACH limits



INSUFFICIENT_FUNDS
400
The source account balance does not cover the amount plus the fee (when the chapter pays it)



Not found
404
The counterparty does not exist or does not belong to this chapter



DUPLICATE_REQUEST
409
Another request with the same idempotency key is being processed right now. Retry shortly — the retry returns the payment the first request produced





Business Logic


Same rails as inline ACH: fees, limits, balance checks, same-day gating, instant-transfer conversion, and cancellation are identical to the ACH Payment request — the only difference is where the bank details come from

Credits only: saved counterparties can only receive money; there is no debit variant

Idempotency scope is shared with ach: the same idempotency key used as ach and as achCounterparty still produces at most one payment

Concurrent duplicates: while a request is in flight, a second request with the same idempotency key is rejected with 409 DUPLICATE_REQUEST; retrying after the first request completes returns the payment it produced

Organization-managed counterparties: paying a managed counterparty notifies it by email per its notification rules, subject to the partner's email-notification configuration
REQUEST BODY: {
    "data": {
        "type": "achCounterparty",
        "payments": [
            {
                "counterpartyId": "{{counterparty_id}}",
                "amount": 125000,
                "description": "Invoice 42",
                "addenda": "PO-778899 October services",
                "sameDay": false,
                "applyFee": true,
                "idempotencyKey": "7f6bd1ce-8c4a-4b8e-9d3f-2a1b3c4d5e6f"
            }
        ]
    }
}
RESPONSE 201 ACH payment to saved counterparty created: {
    "data": {
        "id": "1287347",
        "method": "ach",
        "status": "pending",
        "amount": 125000,
        "description": "Invoice 42",
        "addenda": "PO-778899 October services",
        "sameDay": false,
        "counterpartyId": "2213866",
        "counterparty": {
            "name": "Acme Supplies LLC",
            "accountLast4": "0002",
            "accountType": "Checking"
        },
        "fee": {
            "status": "charged",
            "amount": 249,
            "feeType": "originatedACH"
        },
        "totalDebit": 125249,
        "returnReason": null,
        "createdAt": "2026-08-21T03:20:00.000Z"
    }
}

### Wire Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments
Originate a single outbound wire payment from the chapter's checking account to an external bank account.

Sends this request to the same endpoint as book payments, with type set to wire. The counterparty is supplied inline as bank details plus a mailing address for an external recipient. Exactly one payment is allowed per request.

Request Fields




Field
Type
Required
Description





type
string
Yes
Must be wire



payments
array
Yes
Exactly 1 payment per request



payments[].counterparty
object
Yes
Recipient bank details



payments[].counterparty.name
string
Yes
Recipient name (max 255 characters). Person counterparties require at least a first and last name (2+ words)



payments[].counterparty.routingNumber
string
Yes
Receiving bank ABA routing number (exactly 9 digits)



payments[].counterparty.accountNumber
string
Yes
Receiving bank account number (3-17 digits)



payments[].counterparty.accountType
string
Yes
Checking or Savings



payments[].counterparty.type
string
Yes
Person or Business



payments[].counterparty.address
object
Yes
Recipient mailing address



payments[].counterparty.address.street
string
Yes
Street address (max 100 characters)



payments[].counterparty.address.street2
string
No
Additional address line (max 100 characters)



payments[].counterparty.address.city
string
Yes
City (max 100 characters)



payments[].counterparty.address.state
string
Yes
USPS two-letter state code



payments[].counterparty.address.postalCode
string
Yes
ZIP or ZIP+4



payments[].counterparty.address.country
string
No
ISO 3166-1 alpha-2 country code. Only US is supported. Defaults to US



payments[].amount
integer
Yes
Amount in cents. Minimum 10000 ($100.00)



payments[].description
string
Yes
Payment description (max 50 ASCII characters)



payments[].applyFee
boolean
Yes
true: the chapter account is charged the wire fee. false: no fee is charged to the chapter — the partner is billed separately by Crowded. When false, the response fee.amount is indicative only



payments[].idempotencyKey
string
Yes
UUID v4. Keys are effective for approximately 48 hours; reusing the same key within that window is safe and the payment occurs at most once. Use a fresh UUID for each new payment intent





Wire payments do not support sameDay or addenda — those fields are ACH-only.

Response Fields

The response is the payment resource — the same shape returned by the Get all Payments and Get Payment requests, and delivered as the finance.wire_payment.* webhook payload.




Field
Type
Description





id
string
Payment ID



method
string
wire



status
string
pending, sent, returned, canceled, or failed



amount
number
Amount in cents



description
string
Payment description



counterparty
object
Recipient summary



counterparty.name
string
Recipient name



counterparty.accountLast4
string
Last 4 digits of the receiving account number



counterparty.accountType
string
Checking or Savings



fee
object
Fee outcome



fee.status
string
charged, failed, partner_billed, or none



fee.amount
number
Fee amount in cents. Settled when status is charged; indicative when partner_billed



fee.feeType
string
Resolved fee type



totalDebit
number
Total debited from the chapter account: amount + fee when the chapter pays the fee, amount otherwise



returnReason
string | null
Not applicable to wires — always null



createdAt
string
ISO 8601 timestamp





Note: A declined origination returns HTTP 2xx with the payment resource's status set to failed — not an HTTP error. Inspect status to detect the decline.

Error Codes




Code
HTTP Status
Description





WIRE_NOT_ENABLED
403
Wire origination is not enabled for this chapter



WIRE_NOT_SUPPORTED
400
The account's deposit product does not support wire transfers



INVALID_COUNTERPARTY
400
The counterparty is invalid (for example, it resolves to the originating account itself)



LIMIT_EXCEEDED
400
Amount exceeds the account's wire limits



INSUFFICIENT_FUNDS
400
The source account balance does not cover the amount plus the fee (when the chapter pays it)



DUPLICATE_REQUEST
409
Another request with the same idempotency key is being processed right now. Retry shortly — the retry returns the payment the first request produced





Business Logic


One payment per request: unlike book payments, which allow up to 10 items, ACH and wire requests carry exactly one payment

Fee timing: the wire fee is charged from the chapter checking account after the payment is accepted, not upfront

Wires are final: once a wire has been sent, it cannot be recalled or reversed through this API

Cancellation window: a wire is cancellable while status is pending, including while under review — see the Cancel Payment request. Once sent, it can no longer be canceled

Idempotency scope: keys are scoped to the chapter, so the same key can be reused safely across different chapters

Concurrent duplicates: while a request is in flight, a second request with the same idempotency key is rejected with 409 DUPLICATE_REQUEST instead of being processed twice; retrying after the first request completes returns the payment it produced
REQUEST BODY: {
    "data": {
        "type": "wire",
        "payments": [
            {
                "counterparty": {
                    "name": "Acme Supplies LLC",
                    "routingNumber": "812345678",
                    "accountNumber": "2000000002",
                    "accountType": "Checking",
                    "type": "Business",
                    "address": {
                        "street": "1 Main St",
                        "city": "New York",
                        "state": "NY",
                        "postalCode": "10001",
                        "country": "US"
                    }
                },
                "amount": 2500000,
                "description": "Vendor settlement October",
                "applyFee": true,
                "idempotencyKey": "3c2ad0be-5f6a-4c7d-8e9f-0a1b2c3d4e5f"
            }
        ]
    }
}
RESPONSE 201 Wire payment created: {
    "data": {
        "id": "1287346",
        "method": "wire",
        "status": "pending",
        "amount": 2500000,
        "description": "Vendor settlement October",
        "counterparty": {
            "name": "Acme Supplies LLC",
            "accountLast4": "0002",
            "accountType": "Checking"
        },
        "fee": {
            "status": "charged",
            "amount": 2700,
            "feeType": "outgoingWire"
        },
        "totalDebit": 2502700,
        "returnReason": null,
        "createdAt": "2026-08-20T15:06:42.000Z"
    }
}

### Wire Counterparty Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments
Originate an outbound wire payment to a saved counterparty, referenced by id.

Sends this request to the same endpoint as book payments, with type set to wireCounterparty. Instead of supplying bank details and an address inline (the Wire Payment request), the payment targets a saved counterparty by its id (see the Counterparties requests). The counterparty must have a stored mailing address (wireEligible: true) — add one at creation or via Update Counterparty Address. Exactly one payment is allowed per request.

The resulting payment IS a wire payment: it reads back with method: "wire", emits finance.wire_payment.* webhook events, and can be canceled under the same rules — with a counterpartyId field echoing the saved counterparty on every surface.

Request Fields




Field
Type
Required
Description





type
string
Yes
Must be wireCounterparty



payments
array
Yes
Exactly 1 payment per request



payments[].counterpartyId
string
Yes
ID of a saved counterparty belonging to this chapter. A stored mailing address is required



payments[].amount
integer
Yes
Amount in cents. Minimum 10000 ($100.00)



payments[].description
string
Yes
Payment description (max 50 ASCII characters)



payments[].applyFee
boolean
Yes
true: the chapter account is charged the wire fee. false: no fee is charged to the chapter — the partner is billed separately by Crowded. When false, the response fee.amount is indicative only



payments[].idempotencyKey
string
Yes
UUID v4. Keys are effective for approximately 48 hours; reusing the same key within that window is safe and the payment occurs at most once. Use a fresh UUID for each new payment intent





Wire payments do not support sameDay or addenda — those fields are ACH-only.

Response Fields

The response is the payment resource — the same shape returned by the Get all Payments and Get Payment requests, and delivered as the finance.wire_payment.* webhook payload.




Field
Type
Description





id
string
Payment ID



method
string
wire — the payment is a regular wire payment



status
string
pending, sent, returned, canceled, or failed



amount
number
Amount in cents



description
string
Payment description



counterpartyId
string
The saved counterparty the payment was sent to



counterparty
object
Recipient summary



counterparty.name
string
Recipient name



counterparty.accountLast4
string
Last 4 digits of the receiving account number



fee
object
Fee outcome



fee.status
string
charged, failed, partner_billed, or none



fee.amount
number
Fee amount in cents. Settled when status is charged; indicative when partner_billed



fee.feeType
string
Resolved fee type



totalDebit
number
Total debited from the chapter account: amount + fee when the chapter pays the fee, amount otherwise



returnReason
string | null
Not applicable to wires — always null



createdAt
string
ISO 8601 timestamp





Note: A declined origination returns HTTP 2xx with the payment resource's status set to failed — not an HTTP error. Inspect status to detect the decline.

Error Codes




Code
HTTP Status
Description





COUNTERPARTIES_NOT_ENABLED
403
Counterparties are not enabled for this chapter



WIRE_NOT_ENABLED
403
Wire origination is not enabled for this chapter



WIRE_NOT_SUPPORTED
400
The account's deposit product does not support wire transfers



COUNTERPARTY_ADDRESS_REQUIRED
400
The counterparty has no stored mailing address — add one before sending a wire



INVALID_COUNTERPARTY
400
The counterparty is invalid (for example, it resolves to the originating account itself)



LIMIT_EXCEEDED
400
Amount exceeds the account's wire limits



INSUFFICIENT_FUNDS
400
The source account balance does not cover the amount plus the fee (when the chapter pays it)



Not found
404
The counterparty does not exist or does not belong to this chapter



DUPLICATE_REQUEST
409
Another request with the same idempotency key is being processed right now. Retry shortly — the retry returns the payment the first request produced





Business Logic


Same rails as inline wire: fees, limits, balance checks, finality, and the cancellation window are identical to the Wire Payment request — the wire is composed from the counterparty's stored bank details and mailing address

Address required: only wireEligible counterparties can be wired to; linked bank accounts have no stored address and cannot receive wires

Idempotency scope is shared with wire: the same idempotency key used as wire and as wireCounterparty still produces at most one payment

Concurrent duplicates: while a request is in flight, a second request with the same idempotency key is rejected with 409 DUPLICATE_REQUEST; retrying after the first request completes returns the payment it produced
REQUEST BODY: {
    "data": {
        "type": "wireCounterparty",
        "payments": [
            {
                "counterpartyId": "{{counterparty_id}}",
                "amount": 2500000,
                "description": "Vendor settlement October",
                "applyFee": true,
                "idempotencyKey": "3c2ad0be-5f6a-4c7d-8e9f-0a1b2c3d4e5f"
            }
        ]
    }
}
RESPONSE 201 Wire payment to saved counterparty created: {
    "data": {
        "id": "1287348",
        "method": "wire",
        "status": "pending",
        "amount": 2500000,
        "description": "Vendor settlement October",
        "counterpartyId": "2213866",
        "counterparty": {
            "name": "Acme Supplies LLC",
            "accountLast4": "0002"
        },
        "fee": {
            "status": "charged",
            "amount": 2700,
            "feeType": "outgoingWire"
        },
        "totalDebit": 2502700,
        "returnReason": null,
        "createdAt": "2026-08-21T03:25:00.000Z"
    }
}

### Release Funds — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/payments/release-funds
Transfers the specified amount from held collection funds to the chapter's deposit account. Requires fund holding to be enabled for the partner.

Request Fields




Field
Type
Required
Description





amount
integer
Yes
Amount to release in cents (USD)



idempotencyKey
string
No
Key for duplicate prevention (auto-generated if not provided)





Response Fields




Field
Type
Description





chapterId
string
Chapter UUID



sourceAccountId
string
Source account ID



destinationAccountId
string
Destination account ID (chapter deposit account)



amount
integer
Amount transferred in cents



transactionId
string
Transaction ID



status
string
Transfer status: Pending, Sent, or Rejected



reason
string
Human-readable explanation of the rejection. Present only when status is Rejected



reasonCode
string
Machine-readable rejection code, e.g. InsufficientFunds, AccountClosed, AccountFrozen, or Unknown when no specific cause is available. Present only when status is Rejected; new codes may be introduced over time





Error Responses




Status
Description





400
Invalid amount, insufficient balance, or validation error



403
Fund holding not enabled or partner not authorized for chapter



404
Chapter not found





Business Logic


Amount must be positive and not exceed the available held balance



Destination is automatically resolved to the chapter's deposit account



Idempotency key prevents duplicate transfers



A rejected transfer is not an HTTP error: the request still returns 201 with status: Rejected and the reason/reasonCode fields explaining the rejection
REQUEST BODY: {
    "data": {
        "amount": 1,
        "idempotencyKey": "19af7367-006b-4e94-b9e8-dca3c6763ae0"
    }
}

### Move Fees — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/payments/move-fees
Transfers the specified fee amount from held collection funds to the partner's destination account. Requires fund holding to be enabled for the partner.

Request Fields




Field
Type
Required
Description





destinationAccountId
string
Yes
Destination account ID



amount
integer
Yes
Amount to transfer in cents (USD)



idempotencyKey
string
No
Key for duplicate prevention (auto-generated if not provided)





Response Fields




Field
Type
Description





chapterId
string
Chapter UUID



sourceAccountId
string
Source account ID



destinationAccountId
string
Destination account ID (partner account)



amount
integer
Amount transferred in cents



transactionId
string
Transaction ID



status
string
Transfer status: Pending, Sent, or Rejected



reason
string
Human-readable explanation of the rejection. Present only when status is Rejected



reasonCode
string
Machine-readable rejection code, e.g. InsufficientFunds, AccountClosed, AccountFrozen, or Unknown when no specific cause is available. Present only when status is Rejected; new codes may be introduced over time





Error Responses




Status
Description





400
Invalid amount, insufficient balance, or destination account not valid



403
Fund holding not enabled or partner not authorized for chapter



404
Chapter or destination account not found





Business Logic


Amount must be positive and not exceed the available held balance



Destination account must be a valid, active deposit account



Idempotency key prevents duplicate transfers



A rejected transfer is not an HTTP error: the request still returns 201 with status: Rejected and the reason/reasonCode fields explaining the rejection
REQUEST BODY: {
    "data": {
        "destinationAccountId": "account_id",
        "amount": 1,
        "idempotencyKey": "c29a1c47-45ab-46d1-98cb-18acca2effbc"
    }
}

### Collect Platform Charges — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/payments/platform-charges
Collect platform charges from a chapter's account.

Description

Transfers the specified amount from a caller-provided source account as a platform charge. Supports idempotency keys for duplicate prevention.

Request Fields




Field
Type
Required
Description





sourceAccountId
string
Yes
Source deposit account ID to collect from



amount
integer
Yes
Amount to collect in cents (USD)



description
string
Yes
Payment description



idempotencyKey
string
Yes
Key for duplicate prevention





Response Fields




Field
Type
Description





chapterId
string
Chapter UUID



sourceAccountId
string
Source account ID



amount
integer
Amount collected in cents



transactionId
string
Transaction ID



status
string
Transfer status: Pending, Sent, or Rejected



reason
string
Human-readable explanation of the rejection. Present only when status is Rejected



reasonCode
string
Machine-readable rejection code, e.g. InsufficientFunds, AccountClosed, AccountFrozen, or Unknown when no specific cause is available. Present only when status is Rejected; new codes may be introduced over time





Error Responses




Status
Description





400
Invalid amount, insufficient funds, or account unavailable for transactions



403
Partner not authorized for this chapter



404
Chapter, source account, or platform charge account not found





Business Logic


Source account must be a valid, active deposit account belonging to the chapter



Amount must be positive and not exceed the available balance



Idempotency key prevents duplicate charges



A rejected transfer is not an HTTP error: the request still returns 201 with status: Rejected and the reason/reasonCode fields explaining the rejection
REQUEST BODY: {
    "data": {
        "sourceAccountId": "123456",
        "amount": 1,
        "description": "Platform charges",
        "idempotencyKey": "ea169dd1-2e4b-4e75-b099-bee47cc979ee"
    }
}

### Get all Payments — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments?pagination[limit]=10&pagination[offset]=0
List payments originated through this API for a chapter.

Returns payments originated by the partner through the origination requests — book, ACH, and wire — newest first. Statuses reflect the live processing state at the time of the request.

This list covers only payments originated through this API. It does not include held-funds operations (release-funds, move-fees, platform charges) or activity originated outside the partner channel.

Query Parameters

Standard pagination supported.




Parameter
Type
Description





filter[method]
string
Filter by payment method: book, ach, or wire



filter[status]
string
Filter by payment status: pending, processing, sent, returned, canceled, or failed



pagination[limit]
number
Records per page



pagination[offset]
number
Records to skip





Response Fields




Field
Type
Description





payments
array
List of payment resources — see the Get Payment request for the full field set



meta.limit
number
Records per page



meta.offset
number
Records skipped



meta.count
number
Number of records in this page





Business Logic


Newest first: results are ordered by creation time, descending

Fee amounts are indicative on the list: list entries carry only the fee billing type (charged, failed, partner_billed, none). The origination response (or Get Payment) is authoritative for the settled fee amount

Scope: only payments originated by the calling partner for this chapter are visible

### Get Payment — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments/{{payment_id}}
Retrieve a single payment originated through this API.

Returns a payment originated through this API — book, ACH, or wire. The status reflects the live processing state. For returned ACH payments, the return reason code is included.

Response Fields




Field
Type
Description





id
string
Payment ID



method
string
book, ach, or wire



status
string
pending, processing, sent, returned, canceled, or failed



amount
number
Amount in cents



description
string
Payment description



addenda
string | null
Additional description (ACH only, when provided)



sameDay
boolean
Whether same-day ACH was requested (ACH only)



counterpartyId
string
Present when the payment was originated to a saved counterparty (ACH Counterparty Payment / Wire Counterparty Payment)



counterparty
object
Recipient summary (ACH and wire only)



counterparty.name
string
Recipient name



counterparty.accountLast4
string
Last 4 digits of the receiving account number



counterparty.accountType
string
Checking or Savings



accounts
object
Source/destination account ids (book payments only)



accounts.sourceAccountId
string
Source account ID



accounts.destinationAccountId
string
Destination account ID



fee
object | null
Fee outcome (ACH and wire only)



fee.status
string
charged, failed, partner_billed, or none



fee.amount
number
Fee amount in cents



fee.feeType
string
Resolved fee type



totalDebit
number
Total debited from the chapter account: amount + fee when the chapter pays the fee, amount otherwise



returnReason
string | null
ACH return reason code (R01–R85), present when status is returned



createdAt
string
ISO 8601 timestamp





Error Codes




Code
HTTP Status
Description





Not found
404
The payment does not exist, was not originated by this partner, or does not belong to this chapter





Business Logic


Live status: status reflects the payment's current processing state at the moment of the request — the same source of truth the webhook events derive from

Scoped visibility: only payments originated by the calling partner for the requested chapter are visible; anything else returns 404 — existence is never confirmed for other partners' or chapters' payments

Return reason: returnReason is populated only when status is returned (ACH); wires report null

Converted ACH: an ACH that executed as an instant internal transfer still reads back with method: "ach" and status: "sent"

Saved counterparties: counterpartyId is kept on reads and webhooks even after the counterparty itself is deleted

Fee consistency: fee and totalDebit match what the origination response reported for the payment

### Cancel Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments/{{payment_id}}/cancel
Cancel a payment that has not been processed yet.

Cancels a payment originated through this API before it settles. Which payments can be canceled depends on the method:




Method
Cancellable while
Once sent





ACH
pending
Cannot be canceled



Wire
pending, including while under review
Cannot be canceled



Book
Never — book transfers are instant
Never





A canceled wire's funds are returned to the chapter account by a credit.

Response Fields

The response is the canceled payment resource (the same shape as the Get Payment request):




Field
Type
Description





id
string
Payment ID



method
string
ach or wire



status
string
Always canceled on success



amount
number
Amount in cents



description
string
Payment description



counterparty
object
Recipient summary



counterparty.name
string
Recipient name



counterparty.accountLast4
string
Last 4 digits of the receiving account number



counterparty.accountType
string
Checking or Savings (ACH only)



fee
object | null
Fee outcome as of origination



fee.status
string
charged, failed, partner_billed, or none



fee.amount
number
Fee amount in cents



fee.feeType
string
Resolved fee type



totalDebit
number
Total debited at origination: amount + fee when the chapter paid the fee, amount otherwise



createdAt
string
ISO 8601 creation timestamp of the payment





Error Codes




Code
HTTP Status
Description





CANNOT_CANCEL
400
Payment is not in a cancellable state



Not found
404
The payment does not exist, was not originated by this partner, or does not belong to this chapter





Business Logic


ACH: cancellable only while status is pending

Wire: cancellable while status is pending, including while the payment is under review; funds are refunded to the chapter account by a credit

Book: never cancellable — book transfers settle instantly

Webhook: a successful cancellation emits the matching finance.ach_payment.canceled or finance.wire_payment.canceled webhook event

### Quote ACH Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments/quotes/ach
Price an ACH origination before sending it.

Returns the resolved fee (including same-day schedules, waivers, and instant-transfer detection), the total debit, eligibility, and balance sufficiency for a prospective ACH payment. Quotes are side-effect free — no idempotency key is required or consumed, and calling this endpoint never counts against any fee allowance.

Supply the recipient either inline (routingNumber/accountNumber) or as a saved counterparty (counterpartyId) — not both.

Request Fields




Field
Type
Required
Description





amount
integer
Yes
Amount in cents. Minimum 100 ($1.00)



applyFee
boolean
No
Whether the chapter would pay the fee. Defaults to true. When false, the total debit equals the amount and the fee is reported as partner-billed



sameDay
boolean
No
Quote the same-day ACH fee schedule. Defaults to false



counterpartyId
string
No
ID of a saved counterparty. The stored routing and account number are resolved server-side, so the quote matches what an ACH Counterparty Payment would execute. Cannot be combined with routingNumber/accountNumber



routingNumber
string
No
Recipient routing number (9 digits). Enables fee-waiver evaluation



accountNumber
string
No
Recipient account number (3-17 digits). Together with routingNumber, enables detection of instant (free) internal transfers





Response Fields




Field
Type
Description





type
string
ach



amount
number
Amount in cents



applyFee
boolean
Whether the chapter would pay the fee



fee.feeType
string
Resolved fee type



fee.amount
number
Computed fee in cents for this amount



fee.waiverApplied
boolean
true when a routing-number waiver zeroes the fee for this recipient



fee.convertsToInstantTransfer
boolean
true when the recipient resolves to an internal account and the payment would execute as a free instant transfer



fee.calculationRules
array
The fee schedule the amount was computed from



totalDebit
number
Total that would be debited: amount + fee when the chapter pays the fee, amount otherwise



eligibility.sameDayAchSupported
boolean
Whether the account supports same-day ACH



eligibility.minAmount
number | null
Minimum amount in cents (null for ACH)



balance.sufficient
boolean
Whether the account balance covers the total debit right now



returnFee.feeType
string
Fee type charged if the payment is later returned



returnFee.calculationRules
array
Fee schedule charged if the payment is returned



quotedAt
string
ISO 8601 quote timestamp





Error Codes




Code
HTTP Status
Description





Validation error
400
counterpartyId combined with inline bank detail fields, or a field failed validation



Forbidden
403
ACH origination is not enabled for this chapter, or the partner is not authorized



Not found
404
The counterpartyId does not exist or does not belong to this chapter





Business Logic


Side-effect free: quoting never originates a payment, consumes an idempotency key, or affects any fee allowance

Quote matches execution: quoting by counterpartyId uses the counterparty's stored bank details, so waiver and instant-transfer detection match what the payment would do

Pricing may shift: quotes reflect pricing at the moment of issue. The authoritative fee is computed at execution time and returned on the ACH Payment / ACH Counterparty Payment origination response

Return fee is a disclosure: returnFee is additive — if the payment is later returned, the origination fee already charged is not reversed

Balance check is a snapshot: balance.sufficient reflects the account balance at quote time only; it is not reserved or held
REQUEST BODY: {
    "data": {
        "amount": 125000,
        "applyFee": true,
        "sameDay": false,
        "routingNumber": "812345678",
        "accountNumber": "1000000001"
    }
}

### Quote Wire Payment — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/chapter_id/payments/quotes/wire
Price a wire origination before sending it.

Returns the resolved fee, the total debit, eligibility (wire support and the $100 minimum), and balance sufficiency for a prospective wire payment. Quotes are side-effect free — no idempotency key is required or consumed, and calling this endpoint never counts against any fee allowance.

Supply the recipient either inline (routingNumber) or as a saved counterparty (counterpartyId) — not both.

Request Fields




Field
Type
Required
Description





amount
integer
Yes
Amount in cents. Minimum 10000 ($100.00)



applyFee
boolean
No
Whether the chapter would pay the fee. Defaults to true. When false, the total debit equals the amount and the fee is reported as partner-billed



counterpartyId
string
No
ID of a saved counterparty. The stored routing number is resolved server-side, so the quote matches what a Wire Counterparty Payment would execute. Cannot be combined with routingNumber



routingNumber
string
No
Recipient routing number (9 digits). When supplied, fee-waiver evaluation runs and fee.waiverApplied reflects the result





Response Fields




Field
Type
Description





type
string
wire



amount
number
Amount in cents



applyFee
boolean
Whether the chapter would pay the fee



fee.feeType
string
Resolved fee type



fee.amount
number
Computed fee in cents for this amount



fee.waiverApplied
boolean
true when a routing-number waiver zeroes the fee for this recipient



fee.calculationRules
array
The fee schedule the amount was computed from



totalDebit
number
Total that would be debited: amount + fee when the chapter pays the fee, amount otherwise



eligibility.wireSupported
boolean
Whether the account supports wire transfers



eligibility.minAmount
number
Minimum amount in cents (10000 for wire)



balance.sufficient
boolean
Whether the account balance covers the total debit right now



returnFee.feeType
string
Fee type charged if the payment is later returned



returnFee.calculationRules
array
Fee schedule charged if the payment is returned



quotedAt
string
ISO 8601 quote timestamp





Error Codes




Code
HTTP Status
Description





Validation error
400
counterpartyId combined with routingNumber, or a field failed validation



Forbidden
403
Wire origination is not enabled for this chapter, or the partner is not authorized



Not found
404
The counterpartyId does not exist or does not belong to this chapter





Business Logic


Side-effect free: quoting never originates a payment, consumes an idempotency key, or affects any fee allowance

Quote matches execution: quoting by counterpartyId uses the counterparty's stored bank details, so waiver evaluation matches what the payment would do

Pricing may shift: quotes reflect pricing at the moment of issue. The authoritative fee is computed at execution time and returned on the Wire Payment / Wire Counterparty Payment origination response

Return fee is a disclosure: returnFee is additive — if the payment is later returned, the origination fee already charged is not reversed

Balance check is a snapshot: balance.sufficient reflects the account balance at quote time only; it is not reserved or held
REQUEST BODY: {
    "data": {
        "amount": 2500000,
        "applyFee": true,
        "routingNumber": "812345678"
    }
}

## Transactions
Transactions represent financial activity on chapter and contact accounts. These endpoints provide a read-only view into all money movement including purchases, book transfers, ACH transactions, and more.

Key Concepts

Transaction Types




Type
Description





purchaseTransaction
Card purchase



bookTransaction
Internal book transfer



achTransaction
ACH transfer



wireTransaction
Wire transfer



feeTransaction
Fee charged





Counterparty

For book transactions (internal transfers), the counterparty object identifies the other account involved in the transfer — only when that account belongs to the same chapter.

Linking to Collect Payments

Transactions that originate from a collect payment (such as fund releases) expose three identifiers for reconciliation: collectPaymentId, collectRequestId, and collectIntentId. They match the corresponding ids on the GET /v1/collect-payments, collections, and intents listings — letting you trace money movement on an account back to the originating payment, its collection, and the payer intent. The fields are omitted on transactions that don't originate from a collect payment.

### List Chapter Transactions — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/transactions?pagination[limit]=10&pagination[page]=1
Retrieves a paginated list of transactions for all accounts within a chapter. Supports filtering by direction, amount, date range, type, and account ID.

Query Parameters

Standard pagination and sorting supported.




Parameter
Type
Description





search
string
Search across title, type, summary, and external ID



sort[field]
string
Sort by: createdAt, amount, direction, type



filter[direction]
string
Filter by Credit or Debit



filter[amount][min]
number
Minimum amount in cents



filter[amount][max]
number
Maximum amount in cents



filter[createdAt][min]
string
Start date (ISO 8601)



filter[createdAt][max]
string
End date (ISO 8601)



filter[type]
string
Filter by transaction type (e.g., purchaseTransaction)



filter[accountId]
string
Filter by specific deposit account ID





Response Fields




Field
Type
Description





id
number
Transaction ID



accountId
string
Deposit account ID this transaction belongs to, so each transaction can be attributed to its account.



type
string
Transaction type



direction
string
Credit or Debit



amount
number
Amount in cents



title
string
Transaction title



summary
string
Transaction summary



createdAt
string
ISO 8601 timestamp



category
string | undefined
Transaction category



cardId
string | undefined
Card ID. Present for card-based types (purchaseTransaction, cardTransaction, atmTransaction, cardReversalTransaction).



transactionTags
array
Custom tags: [{ id, name }]



counterparty
object | undefined
Counterparty info (book transactions only)



counterparty.accountId
string
Counterparty deposit account ID



counterparty.product
string
Account product type (wallet, perdiem, checking, hold, org)



counterparty.contactName
string | undefined
Name of the contact who owns the account



collectPaymentId
string | undefined
ID of the collect payment this transaction originated from. Present on transactions that result from a collect payment (e.g., fund releases). Matches the id returned by GET /api/v1/collect-payments.



collectRequestId
string | undefined
ID of the collect request the originating payment belongs to. Present alongside collectPaymentId. Matches the collect request id (e.g. from GET /api/v1/collections).



collectIntentId
string | undefined
ID of the collect intent the originating payment belongs to. Present alongside collectPaymentId. Matches the collect intent id.

### List Account Transactions — GET https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/accounts/:accountId/transactions?pagination[limit]=10&pagination[page]=1
Retrieves a paginated list of transactions for a specific deposit account within a chapter. Same response format and filter options as the chapter-level transactions endpoint, except filter[accountId] is not available (already scoped to the account).

Query Parameters

Standard pagination and sorting supported.




Parameter
Type
Description





search
string
Search across title, type, summary, and external ID



sort[field]
string
Sort by: createdAt, amount, direction, type



filter[direction]
string
Filter by Credit or Debit



filter[amount][min]
number
Minimum amount in cents



filter[amount][max]
number
Maximum amount in cents



filter[createdAt][min]
string
Start date (ISO 8601)



filter[createdAt][max]
string
End date (ISO 8601)



filter[type]
string
Filter by transaction type





Response Fields

Same as List Chapter Transactions.

## Embedded Tokens

### Generate Embedded Token — POST https://sandbox-api.crowdedfinance.com/api/v1/chapters/:chapterId/contacts/:contactId/embedded-token
Generates a short-lived access token for embedding Crowded UI components.

Creates a time-limited token scoped to a specific contact within a chapter. The token can be used to authenticate embedded payment forms or other UI widgets in the partner's application.

Request Body

No request body required.

Response Fields




Field
Type
Description





accessToken
string
Short-lived JWT for embedded UI authentication



tokenId
string
Unique identifier for the generated token



expiresIn
number
Token expiration time in seconds





Notes


Tokens are short-lived — generating a new token for the same contact invalidates any previous embedded token

The contact must belong to the specified chapter

Generate tokens server-side only — do not expose your partner credentials in client code

## Webhooks
Webhooks allow you to receive real-time notifications when events occur in your Crowded account. Instead of polling our API, webhooks push event data to your specified endpoint.

How Webhooks Work

1. Event occurs (e.g., payment succeeds)
2. Crowded creates webhook event
3. Event delivered to your endpoint
4. Your server responds with 2xx status
5. Event marked as delivered


Key Concepts

Webhook Registration

A webhook registration defines where and how events are delivered:


URL: Your HTTPS endpoint that receives events



Events: Event types to subscribe to. Use ["\*"] for all types available when the registration is created or updated.



Secret: Used to verify webhook signatures



Delivery Mode: at_least_once (retries) or at_most_once (no retries)




Webhook Events

Each event delivery includes:


Event Type: The type of event (e.g., collect.payment.succeeded)



Event ID: Unique identifier for idempotency



Payload: Event data in JSON format



Signature: HMAC-SHA256 signature for verification




Delivery Modes




Mode
Behavior
Use Case





at_least_once
Retries until delivered or max attempts
Critical events (payments, accounts)



at_most_once
Single attempt, no retries
Non-critical, high-volume events





Delivery Attempts

Failed deliveries are automatically retried using exponential backoff with jitter (for at_least_once mode):

Phase 1 (Exponential): Delays double each attempt (1s -> 2s -> 4s -> 8s -> ...) until reaching the 1-hour cap.

Phase 2 (Hourly): Once at 1-hour intervals, retries continue for up to 48 hours.

Then DLQ: After all retry attempts exhausted, event is moved to dead-letter queue and can be manually retried.

Event Types

Event types follow the pattern {namespace}.{resource}.{action}.

Wildcard Subscription

Use ["\*"] in the events array to subscribe to all event types available when the registration is created or updated. Existing registrations do not automatically receive future event types. To include new events, update the events list explicitly or save the registration again with ["\*"].

Namespaces




Namespace
Description





collect
Payment collection events (payments, refunds, collections, intents)



platform
Core platform events (organizations, chapters, contacts)



finance
Finance and account events (accounts, applications, transactions, authorizations)





Security

Signature Verification

All webhook deliveries include a signature header for verification:

X-Webhook-Signature: sha256=<signature>


Verify by computing HMAC-SHA256 of the raw request body (JSON string) using your webhook secret.

Note: Events are delivered in batches. The signature covers the entire batch payload, not individual events. See Event Types Overview for the full payload structure.

URL Requirements


Must use HTTPS (HTTP not allowed in production)



Cannot point to localhost, private IPs, or cloud metadata endpoints



Must respond within 30 seconds




Custom Authorization Header

You can configure a custom Authorization header to be sent with each webhook delivery:


Set during webhook creation or update via the authorizationHeader field



Supports any format: Bearer , Basic , ApiKey , etc.



Stored encrypted at rest and never exposed after creation



Check hasAuthorizationHeader field in responses to see if one is configured



Set to null in an update request to remove the header




Idempotency

Each event includes a unique eventId field. Use this to detect and handle duplicate deliveries:


Store processed eventId values



Before processing, check if eventId was already handled



If duplicate, return 2xx but skip processing

### Event Types
This section documents the payload structure for each webhook event type. Events are delivered in batches with a common envelope structure.

Batched Payload Structure

All webhook deliveries use a batched format, even for single events:

{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "count": 1,
  "events": [
    {
      "eventId": "661f9500-f39c-52e5-b827-557766551111",
      "eventType": "collect.payment.succeeded",
      "version": "1.0",
      "timestamp": "2025-01-01T00:00:00.000Z",
      "context": {
        "partnerId": "partner-uid",
        "organizationId": "org-uid",
        "chapterId": "chapter-uid"
      },
      "data": {
        // Event-specific data (see individual event docs)
      }
    }
  ]
}



Batch Envelope Fields




Field
Type
Description





batchId
string
Unique batch ID (UUID)



count
number
Number of events in this batch



events
array
Array of event payloads





Event Envelope Fields




Field
Type
Description





eventId
string
Unique event ID (UUID) - use for idempotency



eventType
string
Event type (e.g., collect.payment.succeeded)



version
string
Schema version (currently 1.0)



timestamp
string
ISO 8601 timestamp when event occurred



context.partnerId
string
Partner UID



context.organizationId
string
Organization UID



context.chapterId
string
Chapter UID



data
object
Event-specific data





Webhook Headers

Each webhook delivery includes these headers:




Header
Description





Content-Type
application/json



X-Webhook-Batch
Unique batch ID



X-Webhook-Batch-Count
Number of events in batch



X-Webhook-Signature
sha256={signature} - HMAC-SHA256 of payload



X-Webhook-Attempt
Delivery attempt number (1, 2, 3...)



User-Agent
Crowded-Webhooks/1.0



Authorization
Custom header value (if configured)





Signature Verification

Verify webhook authenticity using HMAC-SHA256:

const crypto = require('crypto');
function verifySignature(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return `sha256=${expectedSignature}` === signature;
}
// Usage
const isValid = verifySignature(
  requestBody,
  req.headers['x-webhook-signature'],
  yourWebhookSecret
);



Idempotency

Each event has a unique eventId. Use this to prevent duplicate processing:


Store processed eventId values in your database



Before processing, check if eventId was already handled



If duplicate, return 200 OK but skip processing




Event Namespaces




Namespace
Description





collect
Payment collection events



platform
Core platform entities



finance
Finance accounts, applications, transactions, authorizations

#### Collect
Collect Events

Payment collection events. These events cover payments, refunds, collections, intents, and payment plans.

Collection Events

collect.collection.created

Triggered when a new collection (dues, donation, or goods) is created.

collect.collection.updated

Triggered when a collection is updated (title, dates, amount, etc.).

collect.collection.canceled

Triggered when a collection is canceled.

Collection Event Data




Field
Type
Description





collectionId
string
Collection UID



chapterId
string
Chapter UID



title
string
Collection title



type
string
Collection type: dues, donation, goods



requestedAmount
number
null



status
string
Status: active, paused, canceled, completed



isAmountEditable
boolean
Whether payer can edit the amount



startDate
string
Start date (ISO 8601)



endDate
string
End date (ISO 8601)



createdAt
string
Created timestamp (ISO 8601)



updatedAt
string
Updated timestamp (ISO 8601)






Payment Events

collect.payment.pending

An ACH collection payment has been accepted and is awaiting processing. Acceptance does not confirm completion.

collect.payment.processing

An ACH collection payment is processing and has not completed yet.

collect.payment.canceled

An ACH collection payment was canceled before completion.

collect.payment.returned

An ACH collection payment was returned. A return can occur after success; update your records to reflect the return. A return is not a refund.

collect.payment.succeeded

Triggered when a payment completes successfully. Covers all payment types: one-time, recurring, installment, and manual.

collect.payment.failed

Triggered when a payment attempt fails. For compatibility, ACH cancellations and returns also emit this event when the payment first enters an unsuccessful state (failed, canceled, or returned). Partners subscribed to both the specific event and failed receive distinct events with distinct eventId values; apply the unsuccessful outcome once per payment.

collect.payment.refunded

Triggered when a payment is refunded (full or partial).

ACH lifecycle and subscriptions

The usual lifecycle is pending → processing → succeeded. The completion status is succeeded, not completed. Some payments skip intermediate statuses. Acceptance reports the current payment status, usually pending; it does not produce an early success notification.

A successful collection payment does not by itself mean held funds have been released to the chapter checking account.

To receive the new ACH events, update the registration’s events list explicitly or save it again with ["*"]. Registrations save the event types available when created or updated; future event types are not added automatically.

Deliveries can arrive out of order. With at_least_once delivery, retries can repeat an event. Deduplicate by eventId, correlate lifecycle events by paymentId, and use Get Collection Payment to reconcile delayed notifications.

Payment Event Data




Field
Type
Description





paymentId
string
Payment UID



intentId
string
Intent UID



collectionId
string
Collection UID



contactId
string
Contact UID



amount
number
Net payment amount in cents (what org receives)



fee
number
Fee amount in cents (0 for manual payments)



method
string
Payment method (see below)



status
string
Status: pending, processing, succeeded, failed, canceled, returned, refunded



failureReason
string
Public failure reason (if failed). ACH failures preserve standard return codes such as R01 or R02, or use a public description with a generic fallback for unknown reasons



refundReason
string
Refund reason (if refunded)



refundDetailId
string
Refund detail ID (for partial refund deduplication)



feeRefunded
boolean
Whether the fee was included in the refund



plan
object
Payment plan context (if part of a plan, see below)





Payment Methods




Method
Description





card
Credit/debit card



ach
Bank transfer (ACH)



cash
Cash (manual)



check
Check (manual)



external
External payment (manual)





Payment Plan Context (if applicable)




Field
Type
Description





planId
string
Plan UID



type
string
Plan type: recurring, installment



frequency
string
Payment frequency: Month, Year



paymentNumber
number
Payment number in series (1, 2, 3...)



totalPayments
number
null



remainingBalance
number
Remaining balance in cents (installment only)



nextPaymentDate
string
null






Payment Plan Events

collect.payment_plan.created

Triggered when a recurring or installment payment plan is created.

collect.payment_plan.canceled

Triggered when a payment plan is canceled.

collect.payment_plan.completed

Triggered when a payment plan completes all scheduled payments.

Payment Plan Event Data




Field
Type
Description





planId
string
Plan UID



intentId
string
Intent UID



collectionId
string
Collection UID



contactId
string
Contact UID



type
string
Plan type: recurring, installment



totalAmount
number
Total amount in cents (installment only)



totalPayments
number
null



completedPayments
number
Number of payments completed



frequency
string
Payment frequency: Month, Year



status
string
Status: active, canceled, completed



totalPaid
number
Total amount paid so far in cents



firstPaymentDate
string
First payment date (ISO 8601)



cancellationReason
string
Cancellation reason (if canceled)



completedAt
string
Completion date (ISO 8601, if completed)






Refund Events

collect.refund.initiated

Triggered when a refund is initiated.

collect.refund.processing

Triggered when a refund begins processing.

collect.refund.reversed

Triggered when a refund is reversed (e.g., bank rejection).

Refund Event Data




Field
Type
Description





refundId
string
Refund detail ID



paymentId
string
Original payment UID



intentId
string
Intent UID



collectionId
string
Collection UID



contactId
string
Contact UID



amount
number
Refund amount in cents



status
string
Status: initiated, processing, completed, reversed



reason
string
Refund reason



reversalReason
string
Reversal reason (if reversed)






Intent Events

collect.intent.created

Triggered when a payment intent is created for a contact.

collect.intent.updated

Triggered when a payment intent is updated (amount change, status change, etc.).

Intent Event Data




Field
Type
Description





intentId
string
Intent UID



collectionId
string
Collection UID



contactId
string
Contact UID



requestedAmount
number
Requested amount in cents



status
string
Status: pending, paid, partially_paid, canceled



amountPaid
number
Amount paid so far in cents



createdAt
string
Created timestamp (ISO 8601)



updatedAt
string
Updated timestamp (ISO 8601)

##### Collection Payment Events (ACH) — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks/event-types
Lifecycle events for ACH collection payments (method: "ach"). Card, manual, refund, and payment-plan event contracts are unchanged; card payments do not emit pending, processing, canceled, or returned.

Event types


collect.payment.pending — the ACH payment was accepted and is awaiting processing. Acceptance is not confirmation that the payment completed.



collect.payment.processing — the ACH payment is processing and has not completed yet.



collect.payment.succeeded — the payment completed successfully. The public completion status is succeeded (not completed).



collect.payment.canceled — the ACH payment was canceled before completion.



collect.payment.returned — the ACH payment was returned by the payer's bank. A return can occur after collect.payment.succeeded was delivered; update your records to reflect the reversal. A return is not a refund and does not emit collect.payment.refunded.



collect.payment.failed — retained for compatibility. Emitted when the payment first enters the unsuccessful group (failed, canceled, or returned). A cancellation or return emits both its specific event and collect.payment.failed when the previous status was outside that group; moving between unsuccessful statuses does not emit another failed event. These are distinct events with different eventId values, not duplicate deliveries. If you subscribe to both, apply the unsuccessful outcome once per paymentId.




Lifecycle

The usual path is pending → processing → succeeded. Intermediate states may be skipped when a payment completes quickly. returned can follow succeeded.

pending → processing → succeeded → returned
pending or processing → canceled or failed



succeeded means the collection payment completed. It does not by itself mean held funds have been released to the chapter's checking account.



Registrations created before these event types existed do not receive them until the events list is updated or re-saved with ["\*"]. Wildcard does not automatically add future event types to an existing registration. See Create Registration and Update Registration.



Delivery follows the registration’s delivery mode: at_least_once retries failed deliveries, while at_most_once makes a single attempt without retries. Events may arrive out of order. Deduplicate retries by eventId, correlate lifecycle events by paymentId, and use Get Payment (Collections → Payments) to reconcile the current status. The API returns capitalized statuses (Pending, Processing, Succeeded, Failed, Cancelled, Returned, Refunded) that correspond to the lowercase webhook statuses.




Payload

Events use the standard batch envelope and Payment Event Data fields described in the Collect folder. status is one of pending, processing, succeeded, failed, canceled, returned, refunded. failureReason is present on collect.payment.failed: for ACH it is a standard return code such as R01 or R02, or a short public description; unrecognized reasons use a generic description such as ACH payment returned.

Example collect.payment.pending event (inside the events array of a batch):

{
  "eventId": "7c1e2b3a-4d5f-4a6b-8c7d-9e0f1a2b3c4d",
  "eventType": "collect.payment.pending",
  "version": "1.0",
  "timestamp": "2025-01-06T14:02:11.000Z",
  "context": {
    "partnerId": "partner-uid",
    "organizationId": "org-uid",
    "chapterId": "chapter-uid"
  },
  "data": {
    "paymentId": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
    "intentId": "9b2c3d4e-5f60-4718-a2b3-c4d5e6f70819",
    "collectionId": "1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5a6b",
    "contactId": "0f1e2d3c-4b5a-4968-8776-655443322110",
    "amount": 5000,
    "fee": 150,
    "method": "ach",
    "status": "pending"
  }
}



Example return after success. Two events are emitted for the same paymentId:

{
  "eventId": "8d2f3c4b-5e6a-4b7c-9d8e-0f1a2b3c4d5e",
  "eventType": "collect.payment.returned",
  "version": "1.0",
  "timestamp": "2025-01-10T09:30:00.000Z",
  "context": {
    "partnerId": "partner-uid",
    "organizationId": "org-uid",
    "chapterId": "chapter-uid"
  },
  "data": {
    "paymentId": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
    "intentId": "9b2c3d4e-5f60-4718-a2b3-c4d5e6f70819",
    "collectionId": "1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5a6b",
    "contactId": "0f1e2d3c-4b5a-4968-8776-655443322110",
    "amount": 5000,
    "fee": 150,
    "method": "ach",
    "status": "returned"
  }
}



{
  "eventId": "9e3a4d5c-6f7b-4c8d-a0e1-1f2a3b4c5d6e",
  "eventType": "collect.payment.failed",
  "version": "1.0",
  "timestamp": "2025-01-10T09:30:00.000Z",
  "context": {
    "partnerId": "partner-uid",
    "organizationId": "org-uid",
    "chapterId": "chapter-uid"
  },
  "data": {
    "paymentId": "4f8a1d37-92c5-4b6e-8d10-3e7b5a92c8f6",
    "intentId": "9b2c3d4e-5f60-4718-a2b3-c4d5e6f70819",
    "collectionId": "1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5a6b",
    "contactId": "0f1e2d3c-4b5a-4968-8776-655443322110",
    "amount": 5000,
    "method": "ach",
    "status": "failed",
    "failureReason": "R01"
  }
}

#### Finance
Finance Events

Finance and account events. These events cover deposit accounts, bank applications, transactions, and authorizations.

Account Events

finance.account.created

Triggered when a new deposit account is created for a chapter.

finance.account.updated

Triggered when an account status changes.

finance.account.closed

Triggered when an account is closed.

Account Event Data




Field
Type
Description





accountId
string
Account UID



chapterId
string
Chapter UID



accountType
string
Account type: checking, wallet, perdiem, hold, org



status
string
Account status



createdAt
string
Created timestamp (ISO 8601)






Application Events

finance.application.submitted

Triggered when a bank application is submitted for review.

finance.application.approved

Triggered when a bank application is approved.

finance.application.denied

Triggered when a bank application is denied.

Application Event Data




Field
Type
Description





applicationId
string
Application UID



chapterId
string
Chapter UID



type
string
Application type



status
string
Application status



denialReason
string
Denial reason (if denied)



submittedAt
string
Submitted timestamp (ISO 8601)



decidedAt
string
Decision timestamp (ISO 8601)



createdAt
string
Created timestamp (ISO 8601)






Transaction Events

finance.transaction.created

Triggered when a new transaction is posted to a chapter-owned deposit account. Mirrors the shape returned by GET /v1/chapters/:chapterId/transactions so polling and webhook responses are interchangeable.

Behaviour


Idempotency key: (transactionId, accountId). transactionId alone is not unique — see "Book transactions" below.

Routing: events are routed to partners by the account's chapter (resolved from the accountId).

Idempotent ingest: if the same transaction is delivered twice (upstream retry), only the first ingest emits an event.

Non-chapter accounts: transactions on accounts not associated with a chapter do not emit events.


Book transactions

A bookTransaction is a transfer between two deposit accounts. Two events fire for the same transaction id — one per leg (debit + credit) — with different accountId values.

If both legs belong to chapter accounts you own, you receive two webhook events sharing the same transactionId but with different accountId values. Use (transactionId, accountId) as your idempotency key.

If one leg's counterparty is a Crowded settlement / sweep account or an account you don't own, only the leg that targets your chapter fires a webhook.

Transaction Event Data




Field
Type
Description





transactionId
number
External transaction ID. Same value as id on the REST endpoint.



accountId
string
Deposit account ID for this leg.



type
string
Transaction type (e.g. purchaseTransaction, bookTransaction, achTransaction).



direction
string
Credit (money in) or Debit (money out).



amount
number
Amount in cents.



title
string
Transaction title.



summary
string
Transaction summary.



category
string
Optional. Merchant category, when present.



cardId
string
Optional. Card ID. Present for card-based types (purchaseTransaction, cardTransaction, atmTransaction, cardReversalTransaction).



counterparty
object
Optional. Only present when the counterparty account belongs to the same chapter.



counterparty.accountId
string
Counterparty's deposit account ID.



createdAt
string
Transaction creation timestamp (ISO 8601). Matches the REST response field.





Example payload — purchaseTransaction

{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "count": 1,
  "events": [
    {
      "eventId": "661f9500-f39c-52e5-b827-557766551111",
      "eventType": "finance.transaction.created",
      "version": "1.0",
      "timestamp": "2026-05-02T17:42:11.000Z",
      "context": {
        "partnerId": "ptr_...",
        "organizationId": "org_...",
        "chapterId": "chp_..."
      },
      "data": {
        "transactionId": 413637722,
        "accountId": "4767710",
        "type": "purchaseTransaction",
        "direction": "Debit",
        "amount": 1500,
        "title": "Square Inc.",
        "summary": "POS Purchase - Square Inc.",
        "category": "Food",
        "cardId": "5813270",
        "createdAt": "2026-05-02T14:30:00.000Z"
      }
    }
  ]
}



Example payload — bookTransaction (intra-chapter)

The debit leg:

{
  "transactionId": 413565457,
  "accountId": "4770061",
  "type": "bookTransaction",
  "direction": "Debit",
  "amount": 5000,
  "title": "Operating -> Per Diem - John Doe",
  "summary": "Book transfer",
  "counterparty": { "accountId": "4783647" },
  "createdAt": "2026-05-02T14:31:00.000Z"
}



The credit leg arrives as a separate webhook event with the same transactionId and the two accountId values swapped.


Authorization Events

finance.authorization.created

Triggered when a card authorization is approved on a chapter card. Fires once per authorization, within seconds of the swipe.

finance.authorization.declined

Triggered when a card authorization is declined.

finance.authorization.canceled

Triggered when an existing authorization is canceled (e.g. expired without capture, or actively canceled by the merchant).

finance.authorization.amount_changed

Triggered when the authorized amount on an existing authorization is adjusted (typical for fuel pumps, restaurant tips, hotel pre-auth-then-checkout).

Behaviour


Source object: events fire for the materialized Authorization only. The synchronous pre-decision lifecycle handled by the card-authorizations API is not exposed.

Routing: events are delivered to partners by account → chapter lookup. Authorizations on accounts not associated with a chapter (e.g. internal sweep accounts) do not fire webhooks.

Idempotency: each delivery has a unique envelope eventId. Use it for partner-side dedup.

cardLast4Digits is deliberately excluded from the payload. Partners can fetch it from GET /v1/chapters/:chapterId/cards/:cardId if needed.


Authorization Event Data




Field
Type
Description





authorizationId
string
Authorization ID.



accountId
string
Deposit account ID for this authorization.



cardId
string
Card ID involved in the authorization.



amount
number
Authorized amount in cents. On amount_changed this is the new amount.



previousAmount
number
Optional. Only on amount_changed — the prior amount in cents.



status
string
Authorized, Completed, Canceled, or Declined.



declineReason
string
Optional. Only on declined events.



merchant
object
Optional. Omitted on amount_changed (upstream event does not carry it).



merchant.name
string
Display name of the merchant.



merchant.mcc
number
4-digit ISO 18245 merchant category code.



merchant.location
string
Optional. Free-form merchant location, e.g. San Francisco, CA, US.



recurring
boolean
Whether the authorization is recurring.



createdAt
string
Authorization creation timestamp (ISO 8601).





Example payload — finance.authorization.created

{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "count": 1,
  "events": [
    {
      "eventId": "661f9500-f39c-52e5-b827-557766551111",
      "eventType": "finance.authorization.created",
      "version": "1.0",
      "timestamp": "2026-05-05T01:53:18.881Z",
      "context": {
        "partnerId": "ptr_...",
        "organizationId": "org_...",
        "chapterId": "chp_..."
      },
      "data": {
        "authorizationId": "414287898",
        "accountId": "4796455",
        "cardId": "5817342",
        "amount": 2000,
        "status": "Authorized",
        "merchant": {
          "name": "GS OF WESTERN WA",
          "mcc": 8398,
          "location": "SEATTLE, WA, US"
        },
        "recurring": false,
        "createdAt": "2026-05-05T01:53:18.881Z"
      }
    }
  ]
}



Example payload — finance.authorization.declined

{
  "data": {
    "authorizationId": "414288616",
    "accountId": "4795808",
    "cardId": "5816728",
    "amount": 30360,
    "status": "Declined",
    "declineReason": "InsufficientFunds",
    "merchant": {
      "name": "GSWW WUFOO",
      "mcc": 8398,
      "location": "Seattle, WA, US"
    },
    "recurring": false,
    "createdAt": "2026-05-05T01:56:54.907Z"
  }
}



Example payload — finance.authorization.amount_changed

{
  "data": {
    "authorizationId": "414171208",
    "accountId": "4928179",
    "cardId": "5979637",
    "amount": 90,
    "previousAmount": 126,
    "status": "Authorized",
    "recurring": false,
    "createdAt": "2026-05-05T01:17:53.359Z"
  }
}

##### Partner Payment Events — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks/event-types
Lifecycle events for payments originated through POST /chapters/:chapterId/payments (ACH and wire variants). Book payments and held-funds operations do not emit these events.

Event types


finance.ach_payment.processing — ACH moved from pending to processing



finance.ach_payment.sent / finance.ach_payment.returned / finance.ach_payment.canceled / finance.ach_payment.failed



finance.wire_payment.sent / finance.wire_payment.returned / finance.wire_payment.canceled / finance.wire_payment.failed (wires have no processing phase)




Payload (data): the same payment resource served by the payment read endpoints — paymentId, method, status, amount, description, totalDebit, addenda (ACH), sameDay (ACH), counterparty (name, accountLast4, accountType), accounts (instant internal transfers), fee (status, amount, feeType), returnReason (when status is returned), createdAt. Partners write one parser across the origination response, the read endpoints, and webhook deliveries.

Delivery semantics


At-least-once and unordered: a returned event can arrive without a prior sent having been observed. Treat the payload as a hint and call Get Payment for authoritative current state.



Each delivery carries a unique envelope eventId — use it for partner-side dedup.

#### Platform
Platform Events

Core platform events. These events cover organizations, chapters, and contacts.

Organization Events

platform.organization.created

Triggered when a new organization is created.

platform.organization.updated

Triggered when an organization is updated.

platform.organization.archived

Triggered when an organization is archived.

Organization Event Data




Field
Type
Description





organizationId
string
Organization UID



name
string
Organization name



status
string
Organization status (active, inactive, or archived)



createdAt
string
Created timestamp (ISO 8601)



updatedAt
string
Updated timestamp (ISO 8601)



partnerInvitationId
string
Onboarding link ID (linkId) that created this organization. Present only for organizations created via a partner onboarding link.






Chapter Events

platform.chapter.created

Triggered when a new chapter is created.

platform.chapter.updated

Triggered when a chapter is updated.

platform.chapter.archived

Triggered when a chapter is archived.

Chapter Event Data




Field
Type
Description





chapterId
string
Chapter UID



organizationId
string
Organization UID



name
string
Chapter name



createdAt
string
Created timestamp (ISO 8601)



updatedAt
string
Updated timestamp (ISO 8601)






Contact Events

platform.contact.created

Triggered when a new contact is created.

platform.contact.updated

Triggered when a contact is updated.

platform.contact.archived

Triggered when a contact is archived.

Contact Event Data




Field
Type
Description





contactId
string
Contact UID



chapterId
string
Chapter UID



firstName
string
First name



lastName
string
Last name



email
string
Email address



mobile
string
Mobile phone number (E.164 format)



externalId
string
External reference ID (from partner's system)



createdAt
string
Created timestamp (ISO 8601)






Bulk Contact Events

platform.contacts.bulk_created

Triggered when multiple contacts are created in a single bulk operation.

Bulk Contacts Event Data




Field
Type
Description





chapterId
string
Chapter UID



count
number
Number of contacts created



contactIds
string[]
Array of created contact UIDs

### Events
Webhook events represent individual event occurrences that are delivered (or attempted to be delivered) to your webhook endpoint. This section covers managing and monitoring event delivery.

Event Lifecycle

1. Event occurs in Crowded system
2. Event created with status "pending"
3. Delivery attempted → status "processing"
4. Success (2xx) → status "delivered"
   OR Failure → status "failed" → retry scheduled
5. Max retries exhausted → status "dlq"


Event Statuses




Status
Description





pending
Queued and waiting for delivery



processing
Currently being delivered (in-flight)



delivered
Successfully delivered (2xx response received)



failed
Delivery failed, will be retried (if at_least_once)



dlq
All retries exhausted, moved to dead-letter queue





Retry Behavior

Applies only to webhooks with at_least_once delivery mode:


Exponential Backoff: Delays double each attempt (1s → 2s → 4s → 8s → ...)



Hourly Cap: After reaching 1 hour, retries continue hourly



48-Hour Maximum: Total retry window is approximately 48 hours



DLQ: After all retries exhausted, event moved to dead-letter queue

#### Get All Events — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks/:webhook_registration_id/events
Retrieves a paginated list of events for a specific webhook.

Description

Returns all events sent to a webhook, with optional filtering by status and event type. Useful for monitoring delivery status and debugging.

Path Parameters




Parameter
Type
Description





webhookId
string
Webhook UUID





Query Parameters

Standard pagination and sorting supported.




Parameter
Type
Description





sort[field]
string
Sort by: createdAt, status, eventType



sort[direction]
string
Sort direction: ASC or DESC



filter[status]
string
Filter by status: pending, processing, delivered, failed, dlq



filter[eventType]
string
Filter by event type (e.g., collect.payment.succeeded)





Response Fields




Field
Type
Description





id
string
Event UUID



eventType
string
Type of event (e.g., collect.payment.succeeded)



eventId
string
Unique event identifier for idempotency



status
string
Delivery status: pending, processing, delivered, failed, dlq



attempts
number
Number of delivery attempts made



nextRetryAt
string
ISO 8601 timestamp of next scheduled retry (if applicable)



deliveredAt
string
ISO 8601 timestamp when successfully delivered



createdAt
string
ISO 8601 timestamp





Event Statuses




Status
Description





pending
Queued and waiting for delivery



processing
Currently being delivered (in-flight)



delivered
Successfully delivered (2xx response received)



failed
Delivery failed, will be retried



dlq
All retries exhausted, moved to dead-letter queue

#### Get Event — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks/:webhook_registration_id/events/:webhook_event_id
Retrieves details of a specific webhook event, including all delivery attempts.

Description

Returns detailed information about a single event, including the history of all delivery attempts. Useful for debugging delivery failures.

Path Parameters




Parameter
Type
Description





webhookId
string
Webhook UUID



eventId
string
Event UUID





Response Fields




Field
Type
Description





id
string
Event UUID



eventType
string
Type of event (e.g., collect.payment.succeeded)



eventId
string
Unique event identifier for idempotency



status
string
Delivery status: pending, processing, delivered, failed, dlq



attempts
number
Number of delivery attempts made



nextRetryAt
string
ISO 8601 timestamp of next scheduled retry



deliveredAt
string
ISO 8601 timestamp when successfully delivered



createdAt
string
ISO 8601 timestamp



deliveryAttempts
array
Array of delivery attempt details (most recent first)





Delivery Attempt Fields




Field
Type
Description





attemptNumber
number
Attempt number (1-indexed)



statusCode
number
HTTP status code received



responseBody
string
Response body (truncated to 10KB)



requestDurationMs
number
Request duration in milliseconds



errorMessage
string
Error message if delivery failed



errorCode
string
Error code if delivery failed (e.g., ECONNREFUSED)



attemptedAt
string
ISO 8601 timestamp

#### Retry Event — POST https://sandbox-api.crowdedfinance.com/api/v1/webhooks/:webhook_registration_id/events/:webhook_event_id
Queues a failed event for redelivery.

Description

Manually retries delivery of a failed or dead-lettered event. The event is queued for immediate redelivery.

Path Parameters




Parameter
Type
Description





webhookId
string
Webhook UUID



eventId
string
Event UUID





Response

Returns 202 Accepted when the event is queued for retry.

Business Logic


Only events with status failed or dlq can be retried



Returns 400 Bad Request if event is not in a retryable state



Retry is queued for immediate delivery



Attempt counter is not reset - new attempts are added to history



Events delivered successfully cannot be retried

### Create Registration — POST https://sandbox-api.crowdedfinance.com/api/v1/webhooks
Creates a new webhook registration for the authenticated partner.

Description

Registers a new webhook endpoint to receive event notifications. Returns the webhook secret which must be stored securely - it will not be shown again.

Request Fields




Field
Type
Required
Description





url
string
Yes
HTTPS URL to receive webhook events



events
string[]
Yes
Array of event types to subscribe to. Use ["*"] to subscribe to all event types available when the registration is created. The saved list is a snapshot: event types added later are not included until you update the registration.



deliveryMode
string
No
Delivery mode: at_least_once (default, retries on failure) or at_most_once (no retries)



description
string
No
Description for the webhook (max 500 characters)



secret
string
No
Secret for signature verification. Must be 32-128 characters using alphanumeric or base64 characters (a-z, A-Z, 0-9, _, -, +, /, =). If not provided, a secure secret will be generated.



authorizationHeader
string
No
Authorization header to include with webhook requests (e.g., Bearer token, Basic xyz). Max 2048 characters.





Response Fields




Field
Type
Description





id
string
Webhook UUID



url
string
Webhook endpoint URL



events
string[]
Subscribed event types



deliveryMode
string
Delivery mode: at_least_once or at_most_once



description
string
Webhook description (if provided)



isActive
boolean
Whether webhook is active (true on creation)



hasAuthorizationHeader
boolean
Whether a custom Authorization header is configured



secret
string
Secret key for signature verification (only returned on creation)



authorizationHeader
string
Authorization header value (only returned on creation if provided)



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp





Business Logic


URL must use HTTPS protocol



URL cannot point to localhost, private IPs, or cloud metadata endpoints



Each partner can only have one webhook per unique URL



If no secret is provided, a secure secret is generated automatically



The secret and authorization header are only returned once at creation - store them securely



events is saved as an explicit list, whether you send specific types or ["*"]. To receive event types introduced after creation (for example collect.payment.pending, collect.payment.processing, collect.payment.canceled, collect.payment.returned), update the registration with the new types or re-save events: ["*"]. See Get Event Types for the current list.
REQUEST BODY: {
    "data": {
      "url": "https://example.com",
      "description": "All Events (Testing)",
      "events": ["*"],
      "deliveryMode": "at_least_once"
    }
  }

### Get Event Types — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks/event-types
Retrieves the list of all available event types that can be subscribed to.

Description

Returns all available event types organized by namespace. Use this endpoint to discover which events are available for webhook subscriptions.

Authentication

This endpoint is publicly accessible and does not require authentication.

Response Fields




Field
Type
Description





events
string[]
Flat array of all available event types



byNamespace
object
Events grouped by namespace (collect, platform, finance)



wildcardSupported
boolean
Whether wildcard (*) subscription is supported (always true)





Response Example

{
  "data": {
    "events": [
      "collect.collection.created",
      "collect.collection.updated",
      "collect.collection.canceled",
      "collect.payment.pending",
      "collect.payment.processing",
      "collect.payment.canceled",
      "collect.payment.returned",
      "collect.payment.succeeded",
      "collect.payment.failed",
      "collect.payment.refunded",
      "collect.payment_plan.created",
      "collect.payment_plan.canceled",
      "collect.payment_plan.completed",
      "collect.refund.initiated",
      "collect.refund.processing",
      "collect.refund.reversed",
      "collect.intent.created",
      "collect.intent.updated",
      "platform.organization.created",
      "platform.organization.updated",
      "platform.organization.archived",
      "platform.chapter.created",
      "platform.chapter.updated",
      "platform.chapter.archived",
      "platform.contact.created",
      "platform.contact.updated",
      "platform.contact.archived",
      "platform.contacts.bulk_created",
      "finance.account.created",
      "finance.account.updated",
      "finance.account.closed",
      "finance.application.submitted",
      "finance.application.approved",
      "finance.application.denied",
      "finance.transaction.created",
      "finance.authorization.created",
      "finance.authorization.declined",
      "finance.authorization.canceled",
      "finance.authorization.amount_changed"
    ],
    "byNamespace": {
      "collect": [
        "collect.collection.created",
        "collect.collection.updated",
        "collect.collection.canceled",
        "collect.payment.pending",
        "collect.payment.processing",
        "collect.payment.canceled",
        "collect.payment.returned",
        "collect.payment.succeeded",
        "collect.payment.failed",
        "collect.payment.refunded",
        "collect.payment_plan.created",
        "collect.payment_plan.canceled",
        "collect.payment_plan.completed",
        "collect.refund.initiated",
        "collect.refund.processing",
        "collect.refund.reversed",
        "collect.intent.created",
        "collect.intent.updated"
      ],
      "platform": [
        "platform.organization.created",
        "platform.organization.updated",
        "platform.organization.archived",
        "platform.chapter.created",
        "platform.chapter.updated",
        "platform.chapter.archived",
        "platform.contact.created",
        "platform.contact.updated",
        "platform.contact.archived",
        "platform.contacts.bulk_created"
      ],
      "finance": [
        "finance.account.created",
        "finance.account.updated",
        "finance.account.closed",
        "finance.application.submitted",
        "finance.application.approved",
        "finance.application.denied",
        "finance.transaction.created",
        "finance.authorization.created",
        "finance.authorization.declined",
        "finance.authorization.canceled",
        "finance.authorization.amount_changed"
      ]
    },
    "wildcardSupported": true
  }
}



Usage Notes


Use ["*"] when creating or updating a webhook to subscribe to all event types available at that time. The saved list is a snapshot; event types added later are not included until the registration is updated or re-saved with ["*"].



Event types follow the pattern {namespace}.{resource}.{action}



See the webhooks overview and the Event Types folder for detailed descriptions of each event type

### Get All — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks
Retrieves a paginated list of webhook registrations for the authenticated partner.

Description

Returns all webhook registrations created by the partner. Supports pagination and sorting.

Query Parameters

Standard pagination and sorting supported.




Parameter
Type
Description





sort[field]
string
Sort by: createdAt, url, isActive



sort[direction]
string
Sort direction: ASC or DESC





Response Fields




Field
Type
Description





id
string
Webhook UUID



url
string
Webhook endpoint URL



events
string[]
Subscribed event types



deliveryMode
string
Delivery mode: at_least_once or at_most_once



description
string
Webhook description



isActive
boolean
Whether webhook is active



hasAuthorizationHeader
boolean
Whether a custom Authorization header is configured



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp

### Get — GET https://sandbox-api.crowdedfinance.com/api/v1/webhooks/:webhook_registration_id
Retrieves details of a specific webhook registration.

Description

Returns the details of a single webhook registration by its UUID.

Path Parameters




Parameter
Type
Description





webhookId
string
Webhook UUID





Response Fields




Field
Type
Description





id
string
Webhook UUID



url
string
Webhook endpoint URL



events
string[]
Subscribed event types



deliveryMode
string
Delivery mode: at_least_once or at_most_once



description
string
Webhook description



isActive
boolean
Whether webhook is active



hasAuthorizationHeader
boolean
Whether a custom Authorization header is configured



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp

### Update Registration — PATCH https://sandbox-api.crowdedfinance.com/api/v1/webhooks/:webhook_registration_id
Updates a webhook registration.

Description

Updates an existing webhook registration. All fields are optional - only provided fields will be updated.

Path Parameters




Parameter
Type
Description





webhookId
string
Webhook UUID





Request Fields




Field
Type
Required
Description





url
string
No
New HTTPS URL for the webhook



events
string[]
No
New array of event types to subscribe to. Use ["*"] to subscribe to all event types available at the time of the update. The saved list replaces the previous one and is a snapshot: event types added later are not included until the registration is updated again.



deliveryMode
string
No
Delivery mode: at_least_once (retries on failure) or at_most_once (no retries)



description
string
No
New description (max 500 characters). Set to empty string or null to clear.



isActive
boolean
No
Enable or disable the webhook



authorizationHeader
string
null
No





Response Fields




Field
Type
Description





id
string
Webhook UUID



url
string
Webhook endpoint URL



events
string[]
Subscribed event types



deliveryMode
string
Delivery mode: at_least_once or at_most_once



description
string
Webhook description



isActive
boolean
Whether webhook is active



hasAuthorizationHeader
boolean
Whether a custom Authorization header is configured



createdAt
string
ISO 8601 timestamp



updatedAt
string
ISO 8601 timestamp





Business Logic


If URL is updated, same validation rules apply (HTTPS, no private IPs)



URL must be unique per partner (cannot conflict with another webhook)



Disabling a webhook (isActive: false) stops new event deliveries but does not affect in-flight events



At least one field must be provided in the update request



The authorization header value is never returned after creation - only hasAuthorizationHeader indicates if one is set



Existing registrations do not receive newly introduced event types automatically, including registrations created with ["*"]. To add the ACH lifecycle events (collect.payment.pending, collect.payment.processing, collect.payment.canceled, collect.payment.returned), send an updated events list or re-save events: ["*"]. See Get Event Types for the current list.
REQUEST BODY: {
    "data": {
      "events": ["*"],
      "deliveryMode": "at_least_once"
    }
  }

### Archive — DELETE https://sandbox-api.crowdedfinance.com/api/v1/webhooks/:webhook_registration_id
Deletes a webhook registration.

Description

Soft deletes a webhook registration. Events that are in-progress may still be delivered.

Path Parameters




Parameter
Type
Description





webhookId
string
Webhook UUID





Response

Returns 204 No Content on success.

Business Logic


Webhook is soft deleted (can be audited)



In-progress event deliveries may still complete



Cannot be undone - create a new webhook if needed
REQUEST BODY: {
    "data": {
      "events": ["*"],
      "deliveryMode": "at_least_once"
    }
  }

## Sandbox
Sandbox-only test endpoints for partners integrating with Crowded.

These endpoints are only available in non-production environments (staging, dev). Calling any sandbox endpoint in production returns 404 Not Found — the routes are silently absent.

Use cases


Drive end-to-end tests of card flows without manually triggering real transactions

Exercise the finance.transaction.created webhook subscription with deterministic inputs

Verify partner integration error handling against well-known fixtures

### Simulate Card Purchase — POST https://sandbox-api.crowdedfinance.com/api/v1/sandbox/card-purchases
Simulates a card-purchase transaction against the given card. Sandbox only — returns 404 in production.

Description

Materialises a fake card transaction so partners can drive end-to-end tests without a physical card. Pass only the cardId plus the merchant fields you want to simulate — Crowded resolves any other card details internally.

The simulated transaction flows through the normal ingestion pipeline and triggers a finance.transaction.created webhook delivery for subscribers shortly after the response.

Authentication

Standard partner JWT (Authorization: Bearer <partner_jwt>). The endpoint validates that the requested card belongs to a chapter whose organization is owned by the requesting partner.

Request Fields




Field
Type
Required
Description





cardId
string
yes
Card ID (e.g. card_5813270)



amount
number
yes
Amount in cents, > 0



direction
string
yes
Credit or Debit



merchantName
string
yes
Display name of the merchant (max 200 chars)



merchantType
number
yes
4-digit ISO 18245 MCC code (e.g. 5411 grocery, 5812 eating places)



merchantLocation
string
no
Free-form merchant location (max 200 chars)



merchantId
string
no
Acquirer merchant ID — exactly 15 characters



coordinates
object
no
{ longitude, latitude }





Response Fields

Mirrors a subset of PartnerTransactionResponseDto so partners can reuse the same parser between this endpoint, the transactions REST endpoint, and the finance.transaction.created webhook.




Field
Type
Description





id
number
Transaction ID



type
string
Always purchaseTransaction



direction
string
Credit or Debit



amount
number
Amount in cents



cardId
string
Card ID



title
string
Merchant name (or transaction summary if no merchant)



summary
string
Transaction summary



createdAt
string
ISO 8601 timestamp





Status Codes




Code
Meaning





200
Simulation succeeded; the response body contains the resulting transaction snapshot



400
Validation error (missing required field, invalid amount/direction, etc.)



403
The card does not belong to a chapter accessible by the requesting partner



404
Endpoint is in production and disabled, or the cardId was not found





Webhook side effect

If your webhook subscription includes finance.transaction.created (or *), expect a delivery for the simulated transaction within a few seconds of the response. The webhook payload's transactionId matches id in this response.
REQUEST BODY: {
  "data": {
    "cardId": "card_id",
    "amount": 1500,
    "direction": "Debit",
    "merchantName": "Square Inc.",
    "merchantType": 5411,
    "merchantLocation": "San Francisco, CA"
  }
}
RESPONSE 200 Success: {
  "data": {
    "id": 413637722,
    "type": "purchaseTransaction",
    "direction": "Debit",
    "amount": 1500,
    "cardId": "card_5813270",
    "title": "Square Inc.",
    "summary": "POS Purchase - Square Inc.",
    "createdAt": "2026-05-04T14:30:00.000Z"
  }
}

### Simulate Card Authorization — POST https://sandbox-api.crowdedfinance.com/api/v1/sandbox/card-authorizations
Creates a simulated card authorization on a card the partner controls. Sandbox only — returns 404 in production.

Description

Materialises a fake card authorization so partners can drive the finance.authorization.created (or .declined) webhook deterministically. Pass only the cardId plus the merchant fields you want to simulate — Crowded resolves any other card details internally.

The simulated authorization flows through the normal ingestion pipeline and triggers a finance.authorization.created (or finance.authorization.declined when status: "Declined") webhook delivery for subscribers shortly after the response.

The same authorization is queryable via the read endpoints under /cards/.../authorizations.

Authentication

Standard partner JWT (Authorization: Bearer <partner_jwt>). The endpoint validates that the requested card belongs to a chapter whose organization is owned by the requesting partner.

Request Fields




Field
Type
Required
Description





cardId
string
yes
Card ID (e.g. card_5813270)



amount
number
yes
Authorization amount in cents, > 0



merchantName
string
yes
Display name of the merchant (max 200 chars)



merchantType
number
yes
4-digit ISO 18245 MCC code



merchantLocation
string
no
Free-form merchant location (max 200 chars)



merchantId
string
no
Acquirer merchant ID — exactly 15 characters



recurring
boolean
no
Whether the simulated authorization is recurring (default false)



status
string
no
"Authorized" (default) or "Declined" — declined authorizations carry an upstream-picked declineReason





Response Fields

Mirrors PartnerAuthorizationResponseDto, the same shape returned by the authorization read endpoints and the finance.authorization.* webhook payload.




Field
Type
Description





id
string
Authorization identifier



accountId
string
Deposit account ID for the authorization



cardId
string
Card identifier



amount
number
Authorization amount in cents



status
string
Authorized, Completed, Canceled, or Declined



declineReason
string | undefined
Decline reason. Present only when status === "Declined".



merchant
object | undefined
Merchant snapshot



merchant.name
string
Display name of the merchant



merchant.mcc
number
4-digit ISO 18245 merchant category code



merchant.location
string | undefined
Free-form merchant location



recurring
boolean
Whether the authorization is recurring



createdAt
string
Authorization creation timestamp (ISO 8601)





Status Codes




Code
Meaning





200
Simulation succeeded; the response body contains the resulting authorization snapshot



400
Validation error (missing required field, invalid amount/MCC/status, etc.)



403
The card does not belong to a chapter accessible by the requesting partner



404
Endpoint is in production and disabled, or the cardId was not found





Completing the authorization

To drive the full lifecycle (authorize → charge), pass the id from this response to POST /sandbox/card-purchases as authorizationId. The purchase will complete the held authorization (transition it from Authorized to Completed) instead of creating a standalone charge.

Webhook side effect

If your webhook subscription includes finance.authorization.created, finance.authorization.declined, or *, expect a delivery for the simulated authorization within a few seconds of the response. The webhook payload's authorizationId matches the id in this response.
REQUEST BODY: {
  "data": {
    "cardId": "card_id",
    "amount": 2000,
    "merchantName": "GS OF WESTERN WA",
    "merchantType": 8398,
    "merchantLocation": "SEATTLE, WA",
    "recurring": false,
    "status": "Authorized"
  }
}

### Simulate Increase Card Authorization — POST https://sandbox-api.crowdedfinance.com/api/v1/sandbox/card-authorizations/:authorizationId/increase
Bumps the amount of an existing simulated authorization. Sandbox only — returns 404 in production.

Description

Increases the held amount on an authorization the partner already controls (typically one created by POST /sandbox/card-authorizations). Fires a finance.authorization.amount_changed webhook for subscribers shortly after the response.

Authentication

Standard partner JWT (Authorization: Bearer <partner_jwt>). The endpoint validates that the authorization belongs to a card on a chapter accessible by the requesting partner.

Path Parameters




Parameter
Type
Description





authorizationId
string
Numeric authorization identifier (e.g. 414287898)





Request Fields




Field
Type
Required
Description





amount
number
yes
Additional amount to add to the authorization, in cents, > 0



recurring
boolean
yes
Whether the authorization is recurring





Response Fields

Same shape as PartnerAuthorizationResponseDto (see POST /sandbox/card-authorizations). The returned amount reflects the post-increase value.

Status Codes




Code
Meaning





200
Increase simulation succeeded



400
Validation error (missing or invalid amount / recurring, malformed authorizationId)



403
The authorization does not belong to a chapter accessible by the requesting partner



404
Endpoint is in production and disabled, or the authorizationId was not found





Webhook side effect

If your webhook subscription includes finance.authorization.amount_changed or *, expect a delivery for the simulated increase within a few seconds of the response.
REQUEST BODY: {
  "data": {
    "amount": 500,
    "recurring": false
  }
}

### Simulate Cancel Card Authorization — POST https://sandbox-api.crowdedfinance.com/api/v1/sandbox/card-authorizations/:authorizationId/cancel
Cancels an existing simulated authorization. Sandbox only — returns 404 in production.

Description

Cancels a previously-created authorization and fires a finance.authorization.canceled webhook for subscribers shortly after the response.

Authentication

Standard partner JWT (Authorization: Bearer <partner_jwt>). The endpoint validates that the authorization belongs to a card on a chapter accessible by the requesting partner.

Path Parameters




Parameter
Type
Description





authorizationId
string
Numeric authorization identifier (e.g. 414287898)





Request Body

Empty.

Response Fields

Same shape as PartnerAuthorizationResponseDto (see POST /sandbox/card-authorizations). The returned status is Canceled.

Status Codes




Code
Meaning





200
Cancel simulation succeeded



400
Validation error (malformed authorizationId)



403
The authorization does not belong to a chapter accessible by the requesting partner



404
Endpoint is in production and disabled, or the authorizationId was not found





Webhook side effect

If your webhook subscription includes finance.authorization.canceled or *, expect a delivery for the simulated cancel within a few seconds of the response.

### Simulate Payment Status — POST https://sandbox-api.crowdedfinance.com/api/v1/sandbox/payments/{{payment_id}}/simulate
Drives a payment you originated through a lifecycle status transition. Sandbox only — returns 404 in production.

Simulates a status transition on a payment previously originated through this API (ACH or wire), and emits the matching finance.ach_payment.* or finance.wire_payment.* webhook event, so webhook consumers can be tested end-to-end without waiting on a real settlement cycle.

Only payments originated by the calling partner can be simulated.

Request Fields




Field
Type
Required
Description





status
string
Yes
Status to simulate: processing, sent, returned, canceled, or failed



returnReason
string
No
ACH return reason code to attach when simulating a return (for example R01). Defaults to R01 when status is returned and no code is supplied





Response Fields

The payment resource with status set to the simulated value (the same shape as the Get Payment request):




Field
Type
Description





id
string
Payment ID



method
string
ach or wire



status
string
The simulated status



amount
number
Amount in cents



description
string
Payment description



addenda
string | null
Additional description (ACH only, when provided)



sameDay
boolean
Whether same-day ACH was requested (ACH only)



counterparty
object
Recipient summary



fee
object | null
Fee outcome as of origination



totalDebit
number
Total debited at origination



returnReason
string | null
The simulated return reason, when status is returned



createdAt
string
ISO 8601 creation timestamp of the payment





Status Codes




Code
Meaning





200
Simulation succeeded; the response body contains the payment with the simulated status



400
Validation error (invalid status or returnReason), a book payment, or a status the payment method cannot reach (e.g. processing on a wire)



404
Endpoint is in production and disabled, or the paymentId was not found, was not originated by this partner





Business Logic


Event-only: the simulation emits the webhook event only — it never changes the payment's stored state. A subsequent Get Payment returns the payment's real status, not the simulated one

Method/status validation: statuses a payment method can never reach are rejected — book payments settle instantly and cannot be simulated at all, and wire payments have no processing status

Sequence is not validated: because the stored state never changes, the endpoint does not enforce lifecycle ordering — you may simulate sent and then returned on the same payment (the typical consumer test), or any other order your consumer needs to handle. Real deliveries are also at-least-once and unordered, so consumers must tolerate out-of-order events regardless

Environment: available in sandbox only; production returns 404


Webhook side effect

If your webhook subscription includes the matching finance.ach_payment.* / finance.wire_payment.* event type, or *, expect a delivery shortly after the response. The webhook payload's paymentId matches the id in this response.
REQUEST BODY: {
    "data": {
        "status": "returned",
        "returnReason": "R01"
    }
}
