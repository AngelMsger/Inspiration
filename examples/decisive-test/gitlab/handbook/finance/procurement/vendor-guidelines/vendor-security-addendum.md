---
title: "GitLab Vendor Security Addendum"
---

This Security Addendum ("Addendum") is incorporated into and made part of the applicable Agreement between Vendor and the GitLab Entity listed in such Agreement. Unless otherwise set forth in the applicable Agreement, Vendor's execution of the Agreement shall constitute acceptance of the terms and conditions set forth in this Addendum.

During the Term, and in addition to any terms in the applicable Agreement, Vendor shall be responsible for implementing, maintaining, and complying with the following security measures and obligations:

## I. Security Measures

### A. Corporate Identity, Authentication, and Authorization

Vendor will maintain industry standard best practices for authenticating and authorizing internal employee and service access, which shall include the following security measures and obligations:

1. Single sign-on (SSO) through Vendor's identity provider to authenticate to third-party services used in the delivery of the Services.

2. Role Based Access Controls (RBAC) are used when provisioning internal or external access to the Services.

3. Mandatory multi-factor authentication is used for authenticating to Vendor's identity provider;

4. Unique login identifiers are assigned to each user.

5. Established review and approval processes for any access requests to services storing customer Data or systems and applications that are in scope for the services provided under this Agreement, or systems and applications that have the ability to impact the systems and applications that are in scope for the services provided under this Agreement.

6. Periodic access audits (no less frequently than quarterly) designed to ensure access levels are appropriate for the roles each user performs.

7. Established procedures for immediately, and in no case later than 24 hours, revoking access rights upon employee separation or job transfer.

8. Established procedures for reporting and revoking compromised credentials such as passwords and API keys).

9. Established password reset procedures, including procedures designed to verify the identity of a user prior to a new, replacement, or temporary password (Password requirements shall be no less rigorous than the requirements listed in the most current version of NIST SP 800-63B).

### B. Customer Identity, Authentication, and Authorization

Vendor will maintain industry standard best practices for authenticating and authorizing customers to access the Services, which shall include the following security measures and obligations:

1. Use of a third-party identity access management service to manage customer identity, meaning Vendor does not store user-provided passwords on users' behalf.

2. Logically separating customer data by organization account using unique identifiers (within an organization account, unique user accounts are supported).

### C. Cloud Infrastructure and Network Security

Vendor will maintain industry standard best practices for securing and operating its cloud infrastructure, which shall include the following security measures and obligations:

1. Separate production and non-production environments with no direct link between them;

2. Production resources are deployed behind network security technologies that limit access to only authorized individuals and devices.

3. The Services are routinely (no less than weekly) audited for security vulnerabilities;

4. Identified vulnerabilities will be classified based on their Common Vulnerability Scoring System ("CVSS") rating and remediated in accordance with the following schedule:

   a. Critical - 30 days

   b. High - 30 days

   c. Medium - 90 days

   d. Low - 180 days

5. Application secrets and service accounts are managed by a secrets management service.

6. Network security policies and firewalls are configured for least-privilege access against a pre-established set of permissible traffic flows and on-permitted traffic flows are blocked by default.

7. Services logs are monitored for security and availability and such monitoring shall occur via automated review and alerting mechanisms, as well as periodic manual reviews.

### D. System and Workstation Security

Vendor will maintain industry standard best practices for securing Vendor's corporate systems, which shall include the following security measures and obligations:

1. Endpoint management of corporate workstations.

2. Endpoint management of mobile devices.

3. Automatic application of security configurations to workstations.

4. Endpoint Detection & Response ("EDR") deployed to all workstations.

5. Change management procedures and tracking mechanisms designed to test, approve, and monitor all changes to Vendor's technology and information assets.

6. Infrastructure management and configuration management tools are used for security hardening and to ensure baseline configuration standards have been established for systems and applications that are in scope for the services provided under this Agreement.

7. Detection, prevention, and response technologies deployed to all systems that are in scope for the services provided under this Agreement or systems that have the ability to impact the systems that are in scope for the services provided under this Agreement.

8. Mandatory patch management for all workstations and systems and applications that are in scope for the services provided under this Agreement.

9. Maintaining appropriate security logs and reviewing such logs via automated review and alerting mechanisms, as well as periodic manual reviews.

### E. Data Access

Vendor will maintain industry standard best practices for preventing authorized users from accessing data beyond their authorized access rights and for preventing the unauthorized input, reading, copying, removal, modification, or disclosure of data, which shall include the following security measures and obligations:

1. Employee access to the Services follows the principle of least privilege and only employees whose job function involves supporting the delivery of Services are credentialed to the Services environment.

2. GitLab data submitted to the Services is only used in accordance with the terms of the DPA, Agreement, and any other applicable contractual agreements in place with GitLab.

### F. Data Disclosure

Vendor will maintain industry standard best practices for preventing the unauthorized access, alteration, or removal of data during transfer, and for securing and logging all transfers, which shall include the following security measures and obligations:

1. Encryption of data at rest in production datastores using strong industry standard encryption algorithms.

2. Encryption of data in transit using industry standard protocols and methodologies.

3. Audit trail for all data access requests for production datastores.

4. Full-disk encryption required on all corporate workstations.

5. Device management controls required on all corporate workstations.

6. Prohibition of customer data being stored on or transferred with portable or removable media.

7. Customer data can be deleted upon request.

### G. Services Availability

Vendor will maintain industry standard best practices for maintaining Services functionality through accidental or malicious intent, which shall include the following security measures and obligations:

1. Ensuring that systems may be restored in the event of an interruption in accordance with applicable SLAs.

2. Ensuring that systems are functioning and faults are reported.

3. Anti-malware and intrusion detection/prevention solutions implemented comprehensively across all systems that are in scope for the services provided under this Agreement or systems that have the ability to impact the systems that are in scope for the services provided under this Agreement.

4. Business Continuity / Disaster Recovery ("BC/DR") tabletop exercises are completed on an annual basis.

### H. Data and System Segregation

Vendor will maintain industry standard best practices for separate processing of data collected for different purposes, which shall include the following security measures and obligations:

1. Logical segregation of customer data;

2. Restriction of access to data stored for different purposes according to staff roles and responsibilities;

3. Segregation of business information system functions; and

4. Segregation of testing and production information system environments with no direct link between them.

### I. Risk Management

Vendor will maintain industry standard best practices for detecting and managing cybersecurity risks, which shall include the following security measures and obligations:

1. Threat modeling to document and triage sources of security risk for prioritization and remediation.

2. Penetration testing is conducted on the Services at least annually, and any remediation items identified are resolved as soon as possible on a timetable as noted above for vulnerabilities. Upon request, Vendor will provide summary details of the tests performed and whether the identified issues have been resolved.

3. Annual engagements of a qualified, independent external auditor to conduct periodic reviews of Vendor's security practices against recognized audit standards, including SOC 2 Type II certification audits. Upon reasonable request, Vendor will provide the associated SOC2 report, any applicable certificates (e.g. ISO), and summary details of other applicable audits/assessments.

4. Annual security operational risk assessments of applications and systems that are in scope for the Services provided under this Agreement. Results from risk assessment activities are documented in a risk register and prioritized for treatment based on risk level.

5. A vulnerability management program designed to ensure the prompt remediation of vulnerabilities affecting all systems that are in scope for the services provided under this Agreement or systems that have the ability to impact the systems that are in scope for the services provided under this Agreement. Such remediation shall be conducted in accordance with the timetable noted above for vulnerabilities.

### J. Personnel

Vendor will maintain industry standard best practices for vetting, training, and managing personnel with respect to security matters, which shall include the following security measures and obligations:

1. Background checks, where legally permissible, of employees with access to GitLab data or supporting other aspects of the Services;

2. Annual security training for employees, security training upon hire, and supplemental security training as appropriate.

### K. Physical Access

Vendor will maintain industry standard best practices for preventing unauthorized physical access to Vendor facilities, which shall include the following security measures and obligations:

1. Physical barrier controls including locked doors and gates.

2. 24-hour on-site security guard staffing.

3. 24-hour video surveillance and alarm systems, including video surveillance of common areas and facility entrance and exit points.

4. Access control systems requiring biometrics or photo-ID badge and PIN for entry to all Vendor facilities by Vendor personnel.

5. Visitor identification, sign-in and escort protocols.

6. Logging of facility exits and entries.

### L. Third Party Risk Management

Vendor will maintain industry standard best practices for managing third party security risks, including with respect to any subprocessor or subcontractor to whom Vendor provides GitLab data, which shall include the following security measures and obligations:

1. Written contracts designed to ensure that any agent agrees to maintain reasonable and appropriate safeguards to protect Customer Data. Such safeguards shall be no less stringent than the safeguards outlined in this Agreement; and

2. Vendor Security Assessments: All third parties undergo a formal vendor assessment process maintained by Vendor's Security team.

## II. Security Incident Response

Vendor will maintain a security incident response plan for responding to and resolving events that compromise the confidentiality, availability, or integrity of the Services or GitLab data, which shall include the following security measures and obligations:

1. Vendor aggregates system logs for security and general observability from a range of systems to facilitate detection and response.

2. If Vendor becomes aware that a personal data breach has occurred, Vendor will notify GitLab in accordance with the DPA.

3. Vendor shall notify GitLab without undue delay, and in no case later than 48 hours, in the case of any event that results in the accidental or unlawful destruction, loss, alteration, unauthorized disclosure or access to GitLab data ("Security Incident"). Vendor shall promptly take all actions required to stop and remedy any Security Incident and shall provide reports on remediation efforts as reasonably requested by GitLab. In connection with a Security Incident, Vendor shall provide representatives of GitLab or third parties designated by GitLab with reasonable cooperation.

## III. Security Evaluations

Vendor performs regular security and vulnerability testing to assess whether key controls are implemented properly and are effective as measured against industry security standards and its policies and procedures and to ensure continued compliance with obligations imposed by law, regulation, or contract with respect to the security of GitLab data as well as the maintenance and structure of Vendor's information systems. Vendor shall support GitLab's reasonable third-party risk management requests by responding to relevant questionnaires and making relevant documentation available for GitLab's consumption, including but not limited to SOC reports, penetration test summary reports, applicable certification certificates, and additional documentation reasonably requested by GitLab to validate Vendor's compliance with this Agreement. Such review shall be conducted no more than once annually unless required to do so by applicable law or in response to a Security Incident.
